import { describe, expect, test } from "vitest";
import {
	DEFAULT_ADAPTER_DEADLINE_MS,
	DEFAULT_BATCH_SIZE,
	DEFAULT_LEASE_MS,
	DEFAULT_SEND_CONCURRENCY,
	replicaId,
	workerTiming,
} from "./worker.ts";

describe("workerTiming", () => {
	test("empty env yields defaults that satisfy the lease invariant", () => {
		const timing = workerTiming({});
		expect(timing.leaseMs).toBe(DEFAULT_LEASE_MS);
		expect(timing.adapterDeadlineMs).toBe(DEFAULT_ADAPTER_DEADLINE_MS);
		const waves = Math.ceil(DEFAULT_BATCH_SIZE / DEFAULT_SEND_CONCURRENCY);
		expect(waves * DEFAULT_ADAPTER_DEADLINE_MS).toBeLessThan(DEFAULT_LEASE_MS);
	});

	// The invariant is about the WHOLE batch, because every row in a batch
	// shares one claimed_at. A per-send check would accept this config and let
	// later rows be reclaimed mid-send and delivered twice.
	test("a batch that can outlive its lease is rejected even when one send cannot", () => {
		expect(() =>
			workerTiming({
				DITERO_WORKER_LEASE_MS: "60000",
				DITERO_NOTIFY_DEADLINE_MS: "15000",
				DITERO_WORKER_BATCH_SIZE: "20",
				DITERO_WORKER_CONCURRENCY: "1",
			}),
		).toThrow(/must be less than DITERO_WORKER_LEASE_MS/);
	});

	test("raising concurrency brings the same batch back under the lease", () => {
		expect(() =>
			workerTiming({
				DITERO_WORKER_LEASE_MS: "60000",
				DITERO_NOTIFY_DEADLINE_MS: "15000",
				DITERO_WORKER_BATCH_SIZE: "20",
				DITERO_WORKER_CONCURRENCY: "10",
			}),
		).not.toThrow();
	});

	test("a single send longer than the lease is rejected", () => {
		expect(() =>
			workerTiming({
				DITERO_WORKER_LEASE_MS: "10000",
				DITERO_NOTIFY_DEADLINE_MS: "10000",
				DITERO_WORKER_BATCH_SIZE: "1",
				DITERO_WORKER_CONCURRENCY: "1",
			}),
		).toThrow(/must be less than DITERO_WORKER_LEASE_MS/);
	});

	test.each([
		["0"],
		["-1"],
		["1.5"],
		["abc"],
	])("rejects %s as a batch size", (raw) => {
		expect(() => workerTiming({ DITERO_WORKER_BATCH_SIZE: raw })).toThrow(
			/positive integer/,
		);
	});
});

describe("replicaId", () => {
	test("uses the configured value", () => {
		expect(replicaId({ DITERO_REPLICA_ID: " pod-7 " })).toBe("pod-7");
	});

	test("falls back to a distinct per-process id", () => {
		expect(replicaId({})).not.toBe(replicaId({}));
		expect(replicaId({ DITERO_REPLICA_ID: "" })).toMatch(/^replica-/);
	});
});
