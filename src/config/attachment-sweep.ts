import { positiveInt } from "./env.ts";

export const DEFAULT_ATTACHMENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const DEFAULT_ATTACHMENT_SWEEP_BATCH_SIZE = 100;
export const DEFAULT_ATTACHMENT_SWEEP_MS = 60 * 60_000;
export const MAX_ATTACHMENT_SWEEP_BATCH_SIZE = 1_000;

export type AttachmentSweepConfig = {
	retentionMs: number;
	batchSize: number;
	intervalMs: number;
};

export function attachmentSweepConfig(
	env: Record<string, string | undefined>,
): AttachmentSweepConfig {
	const retentionMs = positiveInt(
		"DITERO_ATTACHMENT_RETENTION_MS",
		env.DITERO_ATTACHMENT_RETENTION_MS,
		DEFAULT_ATTACHMENT_RETENTION_MS,
	);
	if (!Number.isSafeInteger(retentionMs)) {
		throw new Error(
			`DITERO_ATTACHMENT_RETENTION_MS: expected a positive safe integer, got "${env.DITERO_ATTACHMENT_RETENTION_MS}"`,
		);
	}
	const batchSize = positiveInt(
		"DITERO_ATTACHMENT_SWEEP_BATCH_SIZE",
		env.DITERO_ATTACHMENT_SWEEP_BATCH_SIZE,
		DEFAULT_ATTACHMENT_SWEEP_BATCH_SIZE,
	);
	if (batchSize > MAX_ATTACHMENT_SWEEP_BATCH_SIZE) {
		throw new Error(
			`DITERO_ATTACHMENT_SWEEP_BATCH_SIZE: ${batchSize} exceeds the ${MAX_ATTACHMENT_SWEEP_BATCH_SIZE} row cap`,
		);
	}
	const intervalMs = positiveInt(
		"DITERO_ATTACHMENT_SWEEP_MS",
		env.DITERO_ATTACHMENT_SWEEP_MS,
		DEFAULT_ATTACHMENT_SWEEP_MS,
	);
	if (!Number.isSafeInteger(intervalMs)) {
		throw new Error(
			`DITERO_ATTACHMENT_SWEEP_MS: expected a positive safe integer, got "${env.DITERO_ATTACHMENT_SWEEP_MS}"`,
		);
	}
	return { retentionMs, batchSize, intervalMs };
}
