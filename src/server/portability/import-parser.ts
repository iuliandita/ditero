import { Worker } from "node:worker_threads";
import type { ProviderImportOptions } from "../../domain/portability/providers/common.ts";
import {
	type ImportParseJob,
	type ImportParseReply,
	type ImportParseResult,
	ImportParsingError,
} from "./import-parser-protocol.ts";
import { performImportParse } from "./import-parser-work.ts";

let parserBusy = false;
const waitingParsers = new Set<() => void>();

async function acquireParser(
	options: ProviderImportOptions,
): Promise<() => void> {
	if (waitingParsers.size >= 2)
		throw new ImportParsingError("import-busy", 429);
	const deadline = Math.min(
		options.deadline ?? Infinity,
		performance.now() + 15_000,
	);
	while (parserBusy) {
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				waitingParsers.delete(wake);
				options.signal?.removeEventListener("abort", abort);
			};
			const wake = () => {
				cleanup();
				resolve();
			};
			const abort = () => {
				cleanup();
				reject(new ImportParsingError("cancelled", 408));
			};
			const timer = setTimeout(
				() => {
					cleanup();
					reject(new ImportParsingError("timeout", 503));
				},
				Math.max(0, deadline - performance.now()),
			);
			waitingParsers.add(wake);
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) abort();
		});
	}
	if (options.signal?.aborted) throw new ImportParsingError("cancelled", 408);
	if (performance.now() >= deadline)
		throw new ImportParsingError("timeout", 503);
	parserBusy = true;
	return () => {
		parserBusy = false;
		waitingParsers.values().next().value?.();
	};
}

export async function parseImportInWorker<J extends ImportParseJob>(
	job: J,
	options: ProviderImportOptions = {},
): Promise<ImportParseResult<J>> {
	const release = await acquireParser(options);
	try {
		// Node integration tests use Vite's TypeScript transform, not Node's worker loader.
		if (!process.versions.bun && process.env.NODE_ENV === "test") {
			const reply = await performImportParse(
				job,
				Math.min(15_000, (options.deadline ?? Infinity) - performance.now()),
			);
			if (reply.ok) return reply.value;
			if (reply.status >= 500 && reply.code !== "timeout")
				throw new Error("Import parser failed");
			throw new ImportParsingError(reply.code, reply.status);
		}
		return await runWorker(job, options);
	} finally {
		release();
	}
}

function runWorker<J extends ImportParseJob>(
	job: J,
	options: ProviderImportOptions = {},
): Promise<ImportParseResult<J>> {
	const budget = Math.min(
		15_000,
		(options.deadline ?? Infinity) - performance.now(),
	);
	if (options.signal?.aborted)
		return Promise.reject(new ImportParsingError("cancelled", 408));
	if (budget <= 0)
		return Promise.reject(new ImportParsingError("timeout", 503));
	return new Promise((resolve, reject) => {
		const worker = new Worker(
			new URL("./import-parser-worker.ts", import.meta.url),
			{ resourceLimits: { maxOldGenerationSizeMb: 128 } },
		);
		let settled = false;
		const finish = (error?: unknown, result?: ImportParseResult<J>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			void worker.terminate().then(() => {
				if (error) reject(error);
				else resolve(result as ImportParseResult<J>);
			}, reject);
		};
		const abort = () => finish(new ImportParsingError("cancelled", 408));
		const timer = setTimeout(
			() => finish(new ImportParsingError("timeout", 503)),
			budget,
		);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) {
			abort();
			return;
		}
		worker.on("message", (reply: ImportParseReply<J>) => {
			if (reply.ok) finish(undefined, reply.value);
			else if (reply.status < 500 || reply.code === "timeout")
				finish(new ImportParsingError(reply.code, reply.status));
			else finish(new Error("Import parser failed"));
		});
		worker.on("error", (error) => finish(error));
		worker.on("exit", (code) => {
			if (!settled) finish(new Error(`Import parser exited (${code})`));
		});
		try {
			worker.postMessage({ job, budget });
		} catch (error) {
			finish(error);
		}
	});
}
