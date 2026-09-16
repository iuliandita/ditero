import type { Pool, PoolClient } from "pg";
import { afterEach, expect, test, vi } from "vitest";
import { listImportSources } from "./import-plan-store.ts";

afterEach(() => vi.useRealTimers());

test("timed-out acquisitions bound abandoned waiters and release late clients", async () => {
	const arrivals: ((client: PoolClient) => void)[] = [];
	const connect = vi.fn(
		() => new Promise<PoolClient>((resolve) => arrivals.push(resolve)),
	);
	const pool = { connect } as unknown as Pool;
	// list/status operations have no request signal; exercise save's shared acquisition
	// through a query deadline here. Abandoned waiters must still remain bounded.
	vi.useFakeTimers();
	for (let index = 0; index < 2; index++) {
		const pending = listImportSources(pool, "caller");
		const rejected = expect(pending).rejects.toMatchObject({
			code: "import-timeout",
			status: 503,
		});
		await vi.advanceTimersByTimeAsync(15_000);
		await rejected;
	}
	await expect(listImportSources(pool, "caller")).rejects.toMatchObject({
		code: "import-busy",
		status: 429,
	});
	expect(connect).toHaveBeenCalledTimes(2);
	for (const arrive of arrivals) {
		const release = vi.fn();
		arrive({ release } as unknown as PoolClient);
		await Promise.resolve();
		expect(release).toHaveBeenCalledTimes(1);
	}
	connect.mockRejectedValueOnce(new Error("pool recovered"));
	await expect(listImportSources(pool, "caller")).rejects.toThrow(
		"pool recovered",
	);
});

test("a stalled BEGIN loses its connection at the transaction deadline", async () => {
	vi.useFakeTimers();
	let rejectQuery: ((reason: Error) => void) | undefined;
	const query = vi.fn(
		() =>
			new Promise((_, reject) => {
				rejectQuery = reject;
			}),
	);
	const release = vi.fn(() =>
		rejectQuery?.(new Error("Connection terminated")),
	);
	const client = { query, release } as unknown as PoolClient;
	const pool = {
		connect: vi.fn().mockResolvedValue(client),
	} as unknown as Pool;
	const pending = listImportSources(pool, "caller");
	const rejected = expect(pending).rejects.toMatchObject({
		code: "import-timeout",
		status: 503,
	});
	await vi.advanceTimersByTimeAsync(15_000);
	await rejected;
	expect(query).toHaveBeenCalledWith("begin");
	expect(release).toHaveBeenCalledExactlyOnceWith(true);
});
