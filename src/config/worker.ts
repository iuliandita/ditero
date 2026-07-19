import { randomUUID } from "node:crypto";
import { positiveInt } from "./env.ts";

export type WorkerTiming = {
	tickMs: number;
	leaseMs: number;
	// Consumed by the Task 12 adapters, defined here because it is only
	// meaningful next to leaseMs: the two are one constraint, not two knobs.
	adapterDeadlineMs: number;
	batchSize: number;
	retentionMs: number;
	maxQueuedPerUser: number;
};

export const DEFAULT_WORKER_TICK_MS = 1_000;
export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_ADAPTER_DEADLINE_MS = 15_000;
export const DEFAULT_BATCH_SIZE = 20;
export const DEFAULT_RETENTION_MS = 30 * 24 * 3_600_000;
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
		retentionMs: positiveInt(
			"DITERO_OUTBOX_RETENTION_MS",
			env.DITERO_OUTBOX_RETENTION_MS,
			DEFAULT_RETENTION_MS,
		),
		maxQueuedPerUser: maxQueuedPerUser(env),
	};
	// The lease is what lets another replica conclude the holder is dead. If a
	// live send can outlast it, a healthy worker gets its row reclaimed and
	// re-sent underneath it, and the row is delivered twice per hung request
	// rather than once. safeFetch's bodyTimeout bounds only the gap between
	// chunks, so only this total deadline makes the relationship real.
	if (timing.adapterDeadlineMs >= timing.leaseMs) {
		throw new Error(
			`DITERO_NOTIFY_DEADLINE_MS (${timing.adapterDeadlineMs}) must be less than DITERO_WORKER_LEASE_MS (${timing.leaseMs}); a send that can outlive its lease is reclaimed and delivered twice`,
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
