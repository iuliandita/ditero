import { expect, test } from "vitest";
import { publicationEvidenceBudget } from "../../src/server/portability/import-activation-recovery.ts";

test("review reserves retained rows once so exactly one new recipient can fit", () => {
	const seed = publicationEvidenceBudget(
		{ rows: 49_997, bytes: 100 },
		{ rows: 1, bytes: 100 },
		{ rows: 1, bytes: 100 },
	);
	expect(seed).toEqual({ rows: 49_998, bytes: 200 });
	// The publication helper charges the retained row and prospective new row.
	expect(seed.rows + 1 + 1).toBe(50_000);
});

test("review rejects evidence that already exceeds the aggregate bound", () => {
	expect(() =>
		publicationEvidenceBudget(
			{ rows: 49_999, bytes: 100 },
			{ rows: 1, bytes: 100 },
			{ rows: 1, bytes: 100 },
		),
	).toThrowError(/activation-review-limit/);
});
