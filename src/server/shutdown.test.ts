import { describe, expect, test, vi } from "vitest";
import { createShutdown } from "./shutdown.ts";

describe("shutdown", () => {
	test("stops admission and loops, drains work, then closes the database once", async () => {
		const events: string[] = [];
		let finish!: () => void;
		const request = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let busy = true;
		const shutdown = createShutdown({
			server: {
				stop: async () => {
					events.push("http");
					await request;
				},
			},
			jobs: [
				{
					stop: () => {
						events.push("cron");
					},
					isBusy: () => busy,
				},
			],
			stopBackground: [
				async () => {
					events.push("poller");
				},
			],
			closeDatabase: async () => {
				events.push("database");
			},
			exit: (code) => {
				events.push(`exit:${code}`);
			},
		});
		const running = shutdown();
		expect(shutdown()).toBe(running);
		expect(events).toEqual(["cron", "poller", "http"]);
		finish();
		busy = false;
		await running;
		expect(events).toEqual(["cron", "poller", "http", "database", "exit:0"]);
	});

	test("bounds a hung request before database cleanup", async () => {
		const calls: boolean[] = [];
		const close = vi.fn(async () => {});
		const exit = vi.fn();
		await createShutdown({
			server: {
				stop: async (force = false) => {
					calls.push(force);
					if (!force) await new Promise(() => {});
				},
			},
			jobs: [],
			stopBackground: [],
			closeDatabase: close,
			exit,
			drainMs: 20,
			deadlineMs: 500,
		})();
		expect(calls).toEqual([false, true]);
		expect(close).toHaveBeenCalledOnce();
		expect(exit).toHaveBeenCalledWith(0);
	});

	test("still closes the database when a background stop rejects", async () => {
		const close = vi.fn(async () => {});
		await createShutdown({
			server: { stop: async () => {} },
			jobs: [],
			stopBackground: [
				async () => {
					throw new Error("lost connection");
				},
			],
			closeDatabase: close,
			exit: () => {},
		})();
		expect(close).toHaveBeenCalledOnce();
	});
});
