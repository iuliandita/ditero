import { describe, expect, test } from "vitest";
import {
	type AccountSetupRequest,
	type AccountSetupState,
	accountSetupRequestSchema,
	accountSetupRequestSignature,
	accountSetupStateSchema,
	planAccountSetupTransition,
} from "./account-setup.ts";

const basic: AccountSetupRequest = {
	requestId: "12345678-1234-4234-8234-123456789012",
	expectedRevision: 0,
	catalogVersion: 1,
	locale: "en",
	mode: "basic",
};
const pending: AccountSetupState = {
	outcome: "pending",
	revision: 0,
	receipt: null,
};
function commit(state: AccountSetupState, request: AccountSetupRequest) {
	const result = planAccountSetupTransition(state, request);
	if (result.kind !== "commit") throw new Error("Expected new application");
	return result;
}
const nextId = "22345678-1234-4234-8234-123456789012";

describe("account setup contract", () => {
	test.each([
		"ownerId",
		"workspaceId",
		"content",
		"panels",
		"dashboard",
		"starterKeys",
	])("rejects arbitrary basic %s", (key) => {
		expect(
			accountSetupRequestSchema.safeParse({ ...basic, [key]: "injected" })
				.success,
		).toBe(false);
	});
	test.each([
		{ requestId: "not-a-uuid" },
		{ expectedRevision: -1 },
		{ expectedRevision: 0.5 },
		{ expectedRevision: Number.MAX_SAFE_INTEGER },
		{ catalogVersion: 2 },
		{ locale: "xx" },
		{ mode: "advanced" },
	])("rejects malformed or unsupported input %j", (patch) => {
		expect(
			accountSetupRequestSchema.safeParse({ ...basic, ...patch }).success,
		).toBe(false);
	});
	test.each([
		"en",
		"de",
		"es",
		"fr",
		"ro",
		"ar",
	])("accepts supported locale %s", (locale) => {
		expect(
			accountSetupRequestSchema.safeParse({ ...basic, locale }).success,
		).toBe(true);
	});
	test("Basic has exactly two named packs and a dashboard", () => {
		expect(commit(pending, basic).selection).toEqual({
			starterKeys: ["shopping", "cleaning"],
			dashboard: true,
		});
	});
	test("normalizes guided order without silently discarding duplicates", () => {
		const guided = {
			...basic,
			mode: "guided",
			starterKeys: ["cleaning", "shopping"],
			dashboard: false,
		};
		const request = accountSetupRequestSchema.parse(guided);
		expect(request).toMatchObject({ starterKeys: ["shopping", "cleaning"] });
		expect(accountSetupRequestSignature(request)).toBe(
			accountSetupRequestSignature(
				accountSetupRequestSchema.parse({
					...guided,
					starterKeys: ["shopping", "cleaning"],
				}),
			),
		);
		expect(
			accountSetupRequestSchema.safeParse({
				...guided,
				starterKeys: ["shopping", "shopping"],
			}).success,
		).toBe(false);
	});
	test.each([
		{ starterKeys: [] },
		{ starterKeys: ["habits"] },
		{ starterKeys: ["shopping", "packing", "cleaning", "shopping"] },
	])("refuses guided empty/unknown/overbound choice %j", ({ starterKeys }) => {
		expect(
			accountSetupRequestSchema.safeParse({
				...basic,
				mode: "guided",
				starterKeys,
				dashboard: false,
			}).success,
		).toBe(false);
	});
	test("guided dashboard alone is a meaningful bounded choice", () => {
		const request = accountSetupRequestSchema.parse({
			...basic,
			mode: "guided",
			starterKeys: [],
			dashboard: true,
		});
		expect(commit(pending, request).selection).toEqual({
			starterKeys: [],
			dashboard: true,
		});
	});
	test.each([
		"custom",
		"skip",
	] as const)("%s creates no content and persists an explicit outcome", (mode) => {
		const result = commit(pending, { ...basic, mode });
		expect(result.selection).toEqual({ starterKeys: [], dashboard: false });
		expect(result.state.outcome).toBe(mode === "skip" ? "skipped" : "custom");
	});
});

describe("account setup replay and revisions", () => {
	test("lost-response replay is checked before stale revision and never schedules content again", () => {
		const result = commit(pending, basic);
		expect(planAccountSetupTransition(result.state, basic)).toEqual({
			kind: "replay",
			receipt: result.state.receipt,
		});
	});
	test.each([
		{ locale: "de" },
		{ expectedRevision: 1 },
		{ mode: "custom" },
	])("same request identity with changed body conflicts %j", (patch) => {
		const state = commit(pending, basic).state;
		expect(() =>
			planAccountSetupTransition(
				state,
				accountSetupRequestSchema.parse({ ...basic, ...patch }),
			),
		).toThrow("request-conflict");
	});
	test("different concurrent choice cannot replace completed application", () => {
		const state = commit(pending, basic).state;
		expect(() =>
			planAccountSetupTransition(state, {
				...basic,
				requestId: nextId,
				mode: "custom",
			}),
		).toThrow("already-completed");
		expect(() =>
			planAccountSetupTransition(state, {
				...basic,
				requestId: nextId,
				expectedRevision: 1,
			}),
		).toThrow("already-completed");
	});
	test("a concurrent skip wins revision and stale apply refuses", () => {
		const state = commit(pending, { ...basic, mode: "skip" }).state;
		expect(() =>
			planAccountSetupTransition(state, { ...basic, requestId: nextId }),
		).toThrow("revision-conflict");
	});
	test.each([
		"custom",
		"skip",
	] as const)("%s may explicitly apply once but cannot reset or repeat empty transition", (mode) => {
		const state = commit(pending, { ...basic, mode }).state;
		const applied = commit(state, {
			...basic,
			requestId: nextId,
			expectedRevision: 1,
		});
		expect(applied.state).toMatchObject({ outcome: "completed", revision: 2 });
		expect(() =>
			planAccountSetupTransition(state, {
				...basic,
				mode,
				requestId: nextId,
				expectedRevision: 1,
			}),
		).toThrow("apply-required");
	});
	test("legacy may explicitly apply without list-count inference", () => {
		expect(commit({ ...pending, outcome: "legacy" }, basic).state.outcome).toBe(
			"completed",
		);
	});
	test("retained receipt replay does not depend on object existence", () => {
		const state = commit(pending, basic).state;
		// No list/dashboard inputs exist in this planner: deletion cannot change replay.
		expect(planAccountSetupTransition(state, basic).kind).toBe("replay");
	});
	test("input and retained state remain unchanged by planning", () => {
		const before = JSON.stringify({ pending, basic });
		const result = commit(pending, basic);
		result.selection.starterKeys.length = 0;
		expect(JSON.stringify({ pending, basic })).toBe(before);
		expect(result.state.receipt?.request.mode).toBe("basic");
	});
	test.each([
		{ outcome: "completed", revision: 0, receipt: null },
		{ outcome: "pending", revision: 1, receipt: null },
		{ ...commit(pending, basic).state, revision: 2 },
		{ ...commit(pending, basic).state, outcome: "skipped" },
	])("refuses inconsistent durable state %j", (state) => {
		expect(accountSetupStateSchema.safeParse(state).success).toBe(false);
	});
});
