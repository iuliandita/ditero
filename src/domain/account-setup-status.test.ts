import { describe, expect, it } from "vitest";
import {
	type AccountSetupState,
	planAccountSetupTransition,
} from "./account-setup.ts";
import {
	accountSetupStatusResponseSchema,
	accountSetupStatusSchema,
	deriveAccountSetupStatus,
} from "./account-setup-status.ts";

const pending: AccountSetupState = {
	outcome: "pending",
	revision: 0,
	receipt: null,
};
const base = {
	outcome: "pending",
	revision: 0,
	eligibility: "available",
	catalogVersion: 1,
	setupPath: "/setup",
};
function committed(mode: "basic" | "custom" | "skip"): AccountSetupState {
	const result = planAccountSetupTransition(pending, {
		mode,
		requestId: "ba8e3b13-7504-4f05-bd22-ec915358131c",
		expectedRevision: 0,
		catalogVersion: 1,
		locale: "en",
	});
	if (result.kind !== "commit") throw new Error("Expected commit");
	return result.state;
}
describe("account setup status", () => {
	it.each([
		pending,
		{ ...pending, outcome: "legacy" as const },
		committed("basic"),
		committed("custom"),
		committed("skip"),
	])("derives bounded status from $outcome without receipt disclosure", (state) => {
		for (const managed of [false, true]) {
			expect(deriveAccountSetupStatus(state, managed)).toEqual({
				...base,
				outcome: state.outcome,
				revision: state.revision,
				eligibility: managed ? "managed" : "available",
			});
		}
		expect(state.receipt?.request.requestId ?? null).toBe(
			state.receipt ? "ba8e3b13-7504-4f05-bd22-ec915358131c" : null,
		);
	});
	it.each([
		"pending",
		"legacy",
	])("rejects positive revision for %s", (outcome) => {
		expect(
			accountSetupStatusSchema.safeParse({ ...base, outcome, revision: 1 })
				.success,
		).toBe(false);
	});
	it.each([
		"completed",
		"custom",
		"skipped",
	])("requires positive revision for %s", (outcome) => {
		expect(
			accountSetupStatusSchema.safeParse({ ...base, outcome }).success,
		).toBe(false);
		expect(
			accountSetupStatusSchema.parse({
				...base,
				outcome,
				revision: Number.MAX_SAFE_INTEGER,
			}).revision,
		).toBe(Number.MAX_SAFE_INTEGER);
	});
	it.each([
		-1,
		0.5,
		Number.MAX_SAFE_INTEGER + 1,
		NaN,
		Infinity,
	])("refuses unsafe revision %s", (revision) => {
		expect(
			accountSetupStatusSchema.safeParse({ ...base, revision }).success,
		).toBe(false);
	});
	it.each([
		{ userId: "someone" },
		{ email: "private@example.invalid" },
		{ receipt: null },
		{ setupPath: "https://example.invalid/setup" },
		{ catalogVersion: 2 },
		{ eligibility: "unknown" },
		{ outcome: "unknown" },
	])("refuses unsupported status fields %j", (change) => {
		expect(
			accountSetupStatusSchema.safeParse({ ...base, ...change }).success,
		).toBe(false);
	});
	it("validates the standard versioned, unpaginated response", () => {
		const response = { version: 1, data: base, nextCursor: null };
		expect(accountSetupStatusResponseSchema.parse(response)).toEqual(response);
		for (const change of [
			{ version: 2 },
			{ nextCursor: "cursor" },
			{ userId: "someone" },
		])
			expect(
				accountSetupStatusResponseSchema.safeParse({ ...response, ...change })
					.success,
			).toBe(false);
	});
	it("refuses inconsistent authoritative state before deriving", () => {
		expect(() =>
			deriveAccountSetupStatus({ ...pending, revision: 1 }, false),
		).toThrow();
		expect(() =>
			deriveAccountSetupStatus({ ...committed("basic"), revision: 2 }, false),
		).toThrow();
	});
});
