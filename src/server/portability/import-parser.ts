import { Worker } from "node:worker_threads";
import type { ProviderImportOptions } from "../../domain/portability/providers/common.ts";
import {
	type ImportParseJob,
	type ImportParseReply,
	type ImportParseResult,
	ImportParsingError,
} from "./import-parser-protocol.ts";

export function parseImportInWorker<J extends ImportParseJob>(
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
		);
		let settled = false;
		const finish = (error?: unknown, result?: ImportParseResult<J>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			void worker.terminate();
			if (error) reject(error);
			else resolve(result as ImportParseResult<J>);
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
			else finish(new Error(reply.detail));
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
