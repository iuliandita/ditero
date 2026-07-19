import { describe, expect, test } from "vitest";
import { nextEscalation } from "./escalation.ts";
import {
	DEFAULT_MAX_REPEATS,
	MAX_REPEATS_CAP,
	parseEscalationDefaults,
	resolveEscalationPolicy,
	type TaskEscalationFields,
} from "./escalation-policy.ts";

const bare: TaskEscalationFields = {
	repeatEveryMin: null,
	maxRepeats: null,
	fallbackUserId: null,
	urgent: false,
};

describe("resolveEscalationPolicy", () => {
	test("nothing configured anywhere means no repeats, not a throw", () => {
		const policy = resolveEscalationPolicy(bare, null);
		expect(policy).toEqual({
			repeatEveryMin: null,
			maxRepeats: null,
			fallbackUserId: null,
			urgent: false,
		});
		expect(nextEscalation({ fireCount: 1 }, policy, new Date())).toEqual({
			kind: "terminal",
			reason: "no_repeat",
		});
	});

	// The C-class defect this resolver exists to prevent: an unresolved null
	// maxRepeats reaching nextEscalation, which throws on it by design.
	test("repeats enabled with no repeat count anywhere never throws downstream", () => {
		const policy = resolveEscalationPolicy(
			{ ...bare, repeatEveryMin: 10 },
			null,
		);
		expect(policy.maxRepeats).toBe(DEFAULT_MAX_REPEATS);
		expect(() =>
			nextEscalation({ fireCount: 0 }, policy, new Date()),
		).not.toThrow();
	});

	test("task-level fields win over user defaults", () => {
		const policy = resolveEscalationPolicy(
			{
				repeatEveryMin: 5,
				maxRepeats: 2,
				fallbackUserId: "task-fallback",
				urgent: true,
			},
			{ repeatEveryMin: 30, maxRepeats: 9, fallbackUserId: "user-fallback" },
		);
		expect(policy).toEqual({
			repeatEveryMin: 5,
			maxRepeats: 2,
			fallbackUserId: "task-fallback",
			urgent: true,
		});
	});

	test("user defaults fill in each unset task field independently", () => {
		const policy = resolveEscalationPolicy(
			{ ...bare, maxRepeats: 1 },
			{ repeatEveryMin: 30, maxRepeats: 9, fallbackUserId: "user-fallback" },
		);
		expect(policy).toEqual({
			repeatEveryMin: 30,
			maxRepeats: 1,
			fallbackUserId: "user-fallback",
			urgent: false,
		});
	});

	test("maxRepeats: 0 at task level is honored, not treated as unset", () => {
		const policy = resolveEscalationPolicy(
			{ ...bare, repeatEveryMin: 10, maxRepeats: 0 },
			{ maxRepeats: 9 },
		);
		expect(policy.maxRepeats).toBe(0);
	});

	test("a repeat count above the cap is clamped", () => {
		const policy = resolveEscalationPolicy(
			{ ...bare, repeatEveryMin: 1, maxRepeats: 5000 },
			null,
		);
		expect(policy.maxRepeats).toBe(MAX_REPEATS_CAP);
	});

	test("no repeat interval means maxRepeats is not invented", () => {
		const policy = resolveEscalationPolicy(bare, { maxRepeats: 9 });
		expect(policy.repeatEveryMin).toBeNull();
		expect(policy.maxRepeats).toBeNull();
	});

	test("urgent comes from the task only", () => {
		expect(
			resolveEscalationPolicy({ ...bare, urgent: true }, { maxRepeats: 3 })
				.urgent,
		).toBe(true);
	});

	test.each([
		[{ repeatEveryMin: "10" }],
		[{ repeatEveryMin: 0 }],
		[{ repeatEveryMin: 1.5 }],
		[{ maxRepeats: -1 }],
		[{ fallbackUserId: 42 }],
		["not-an-object"],
		[[]],
	])("throws on malformed stored defaults %j", (stored) => {
		expect(() => resolveEscalationPolicy(bare, stored)).toThrow(
			/escalation-policy/,
		);
	});

	test("an invalid task-level repeat interval throws", () => {
		expect(() =>
			resolveEscalationPolicy({ ...bare, repeatEveryMin: -5 }, null),
		).toThrow(/repeatEveryMin/);
	});
});

describe("parseEscalationDefaults", () => {
	test("null and undefined are 'not configured', not an error", () => {
		expect(parseEscalationDefaults(null)).toEqual({});
		expect(parseEscalationDefaults(undefined)).toEqual({});
	});

	test("extra keys are tolerated (the write-path schema is not strict)", () => {
		expect(parseEscalationDefaults({ maxRepeats: 2, future: true })).toEqual({
			maxRepeats: 2,
		});
	});
});
