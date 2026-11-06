import type { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	workers: [] as {
		events: EventEmitter;
		options: { resourceLimits: { maxOldGenerationSizeMb: number } };
		terminate: ReturnType<typeof vi.fn>;
	}[],
}));
vi.mock("node:worker_threads", async () => {
	const { EventEmitter } = await import("node:events");
	return {
		Worker: class extends EventEmitter {
			constructor(
				_url: URL,
				options: { resourceLimits: { maxOldGenerationSizeMb: number } },
			) {
				super();
				fixture.workers.push({
					events: this,
					options,
					terminate: this.terminate,
				});
			}
			postMessage() {}
			terminate = vi.fn(async () => 0);
		},
	};
});

import { parseImportInWorker } from "./import-parser.ts";

test("serializes bounded workers, cancels queued work and requests a heap limit", async () => {
	vi.stubEnv("NODE_ENV", "production");
	const controller = new AbortController();
	const job = { kind: "envelope", text: "{}" } as const;
	try {
		const first = parseImportInWorker(job);
		await vi.waitFor(() => expect(fixture.workers).toHaveLength(1));
		const second = parseImportInWorker(job);
		const third = parseImportInWorker(job, { signal: controller.signal });
		await expect(parseImportInWorker(job)).rejects.toMatchObject({
			code: "import-busy",
			status: 429,
		});
		expect(fixture.workers).toHaveLength(1);
		controller.abort();
		await expect(third).rejects.toMatchObject({
			code: "cancelled",
			status: 408,
		});
		fixture.workers[0].events.emit("message", {
			ok: true,
			value: { first: true },
		});
		expect(await first).toEqual({ first: true });
		await vi.waitFor(() => expect(fixture.workers).toHaveLength(2));
		expect(fixture.workers[0].terminate).toHaveBeenCalledOnce();
		fixture.workers[1].events.emit("message", {
			ok: true,
			value: { second: true },
		});
		expect(await second).toEqual({ second: true });
		expect(fixture.workers[1].terminate).toHaveBeenCalledOnce();
		expect(
			fixture.workers[0].options.resourceLimits.maxOldGenerationSizeMb,
		).toBe(128);
	} finally {
		vi.unstubAllEnvs();
	}
});
