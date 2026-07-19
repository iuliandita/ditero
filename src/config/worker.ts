import { randomUUID } from "node:crypto";
import { positiveInt } from "./env.ts";

export type WorkerTiming = {
	tickMs: number;
	leaseMs: number;
	// Enforced by the worker itself (the module that owns the lease owns the
	// timeout). Task 12's adapters apply it again as defence in depth.
	adapterDeadlineMs: number;
	batchSize: number;
	// How many rows of a batch are in flight at once. Bounds batch wall-clock,
	// which is what keeps the lease invariant below true.
	sendConcurrency: number;
	retentionMs: number;
	pruneCadenceTicks: number;
	pruneBatchSize: number;
	maxQueuedPerUser: number;
};

export const DEFAULT_WORKER_TICK_MS = 1_000;
export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_ADAPTER_DEADLINE_MS = 15_000;
export const DEFAULT_BATCH_SIZE = 20;
export const DEFAULT_SEND_CONCURRENCY = 10;
export const DEFAULT_RETENTION_MS = 30 * 24 * 3_600_000;
export const DEFAULT_PRUNE_CADENCE_TICKS = 60;
export const DEFAULT_PRUNE_BATCH_SIZE = 1_000;
export const DEFAULT_MAX_QUEUED_PER_USER = 500;

type WorkerEnvironment = Record<string, string | undefined>;

// The enqueue side (scheduler) needs this bound without pulling in the send-side
// timings, whose cross-field check is irrelevant there.
export function maxQueuedPerUser(env: WorkerEnvironment): number {
	return positiveInt(
		"DITERO_MAX_QUEUED_PER_USER",
		env.DITERO_MAX_QUEUED_PER_USER,
		DEFAULT_MAX_QUEUED_PER_USER,
	);
}

export function workerTiming(env: WorkerEnvironment): WorkerTiming {
	const timing: WorkerTiming = {
		tickMs: positiveInt(
			"DITERO_WORKER_TICK_MS",
			env.DITERO_WORKER_TICK_MS,
			DEFAULT_WORKER_TICK_MS,
		),
		leaseMs: positiveInt(
			"DITERO_WORKER_LEASE_MS",
			env.DITERO_WORKER_LEASE_MS,
			DEFAULT_LEASE_MS,
		),
		adapterDeadlineMs: positiveInt(
			"DITERO_NOTIFY_DEADLINE_MS",
			env.DITERO_NOTIFY_DEADLINE_MS,
			DEFAULT_ADAPTER_DEADLINE_MS,
		),
		batchSize: positiveInt(
			"DITERO_WORKER_BATCH_SIZE",
			env.DITERO_WORKER_BATCH_SIZE,
			DEFAULT_BATCH_SIZE,
		),
		sendConcurrency: positiveInt(
			"DITERO_WORKER_CONCURRENCY",
			env.DITERO_WORKER_CONCURRENCY,
			DEFAULT_SEND_CONCURRENCY,
		),
		retentionMs: positiveInt(
			"DITERO_OUTBOX_RETENTION_MS",
			env.DITERO_OUTBOX_RETENTION_MS,
			DEFAULT_RETENTION_MS,
		),
		pruneCadenceTicks: positiveInt(
			"DITERO_PRUNE_CADENCE_TICKS",
			env.DITERO_PRUNE_CADENCE_TICKS,
			DEFAULT_PRUNE_CADENCE_TICKS,
		),
		pruneBatchSize: positiveInt(
			"DITERO_PRUNE_BATCH_SIZE",
			env.DITERO_PRUNE_BATCH_SIZE,
			DEFAULT_PRUNE_BATCH_SIZE,
		),
		maxQueuedPerUser: maxQueuedPerUser(env),
	};
	// The lease is what lets another replica conclude the holder is dead, and
	// every row in a batch shares one claimed_at. The bound that matters is
	// therefore the WHOLE batch's wall-clock, not one send's: with the batch
	// dispatched sendConcurrency-at-a-time, the last row's effective deadline is
	// ceil(batchSize / sendConcurrency) waves of adapterDeadlineMs. If that can
	// exceed the lease, another replica reclaims rows this worker is still
	// sending and puts a second copy on the wire -- a real duplicate delivery
	// that the completion fence cannot prevent, because the fence protects row
	// state and not the network.
	const waves = Math.ceil(timing.batchSize / timing.sendConcurrency);
	const worstCaseMs = waves * timing.adapterDeadlineMs;
	if (worstCaseMs >= timing.leaseMs) {
		throw new Error(
			`worker timing: a full batch can take ${worstCaseMs}ms (${waves} waves of DITERO_NOTIFY_DEADLINE_MS=${timing.adapterDeadlineMs}ms at DITERO_WORKER_BATCH_SIZE=${timing.batchSize} / DITERO_WORKER_CONCURRENCY=${timing.sendConcurrency}), which must be less than DITERO_WORKER_LEASE_MS=${timing.leaseMs}; otherwise later rows in a slow batch are reclaimed mid-send and delivered twice`,
		);
	}
	return timing;
}

// Identity written to claimed_by, and the value the completion fence compares
// against. Two replicas sharing one id would fence each other's writes in, so
// an explicit value must be unique per process, not per deployment.
export function replicaId(env: WorkerEnvironment): string {
	const configured = env.DITERO_REPLICA_ID?.trim();
	return configured ? configured : `replica-${randomUUID()}`;
}
