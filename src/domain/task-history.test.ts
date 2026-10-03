import { expect, test } from "vitest";
import { historyPageSchema, parseHistoryCursor } from "./task-history.ts";

test("the total cursor preserves both equal-time source boundaries and empty local IDs", () => {
	for (const sourceKind of ["native", "imported"])
		expect(
			parseHistoryCursor(JSON.stringify({ recordedAt: 0, sourceKind, id: "" })),
		).toEqual({ recordedAt: 0, sourceKind, id: "" });
	expect(parseHistoryCursor(null)).toBeNull();
});
test.each([
	"{",
	JSON.stringify({ recordedAt: 0, id: "x" }),
	JSON.stringify({ recordedAt: 0, sourceKind: "source_claim", id: "x" }),
	JSON.stringify({ recordedAt: 0.5, sourceKind: "native", id: "x" }),
	JSON.stringify({
		recordedAt: 0,
		sourceKind: "native",
		id: "x",
		namespace: "claim",
	}),
	"x".repeat(4097),
])("malformed or unbounded history cursors fail before database access: %s", (value) =>
	expect(() => parseHistoryCursor(value)).toThrow());
test("a display page cannot elevate imported actor or origin provenance", () => {
	const row = {
		recordedAt: 0,
		sourceKind: "imported",
		id: "x",
		action: "complete",
		actor: { kind: "source_claim", displayName: "😀".repeat(512) },
		origin: { kind: "source_claim", mechanism: null, label: "😀".repeat(128) },
		beforeDueAt: null,
		beforeDueAllDay: false,
		habitDate: null,
		afterHabitStatus: null,
		provenanceRedactedAt: null,
	};
	expect(
		historyPageSchema.safeParse({ rows: [row], nextCursor: null }).success,
	).toBe(true);
	for (const changes of [
		{ actor: { kind: "native_user", displayName: "Local" } },
		{ origin: { kind: "native", mechanism: "member_mutation", label: null } },
		{ namespace: "not public" },
	])
		expect(
			historyPageSchema.safeParse({
				rows: [{ ...row, ...changes }],
				nextCursor: null,
			}).success,
		).toBe(false);
	expect(
		historyPageSchema.safeParse({
			rows: Array(101).fill(row),
			nextCursor: null,
		}).success,
	).toBe(false);
});
