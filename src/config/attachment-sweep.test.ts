import { describe, expect, test } from "vitest";
import {
	attachmentSweepConfig,
	DEFAULT_ATTACHMENT_RETENTION_MS,
	DEFAULT_ATTACHMENT_SWEEP_BATCH_SIZE,
	DEFAULT_ATTACHMENT_SWEEP_MS,
} from "./attachment-sweep.ts";

describe("attachmentSweepConfig", () => {
	test("defaults to a bounded batch and a 30-day restore window", () => {
		expect(attachmentSweepConfig({})).toEqual({
			retentionMs: DEFAULT_ATTACHMENT_RETENTION_MS,
			batchSize: DEFAULT_ATTACHMENT_SWEEP_BATCH_SIZE,
			intervalMs: DEFAULT_ATTACHMENT_SWEEP_MS,
		});
		expect(DEFAULT_ATTACHMENT_RETENTION_MS).toBe(30 * 24 * 60 * 60_000);
		expect(DEFAULT_ATTACHMENT_SWEEP_BATCH_SIZE).toBe(100);
	});

	test("accepts explicit positive integers", () => {
		expect(
			attachmentSweepConfig({
				DITERO_ATTACHMENT_RETENTION_MS: "86400000",
				DITERO_ATTACHMENT_SWEEP_BATCH_SIZE: "250",
				DITERO_ATTACHMENT_SWEEP_MS: "60000",
			}),
		).toEqual({ retentionMs: 86_400_000, batchSize: 250, intervalMs: 60_000 });
	});

	test("rejects unsafe retention and unbounded batches", () => {
		expect(() =>
			attachmentSweepConfig({ DITERO_ATTACHMENT_RETENTION_MS: "0" }),
		).toThrow(/DITERO_ATTACHMENT_RETENTION_MS/);
		expect(() =>
			attachmentSweepConfig({
				DITERO_ATTACHMENT_RETENTION_MS: String(Number.MAX_SAFE_INTEGER + 1),
			}),
		).toThrow(/DITERO_ATTACHMENT_RETENTION_MS/);
		expect(() =>
			attachmentSweepConfig({ DITERO_ATTACHMENT_SWEEP_BATCH_SIZE: "1001" }),
		).toThrow(/DITERO_ATTACHMENT_SWEEP_BATCH_SIZE/);
		expect(() =>
			attachmentSweepConfig({ DITERO_ATTACHMENT_SWEEP_MS: "0" }),
		).toThrow(/DITERO_ATTACHMENT_SWEEP_MS/);
		expect(() =>
			attachmentSweepConfig({
				DITERO_ATTACHMENT_SWEEP_MS: String(Number.MAX_SAFE_INTEGER + 1),
			}),
		).toThrow(/DITERO_ATTACHMENT_SWEEP_MS/);
	});
});
