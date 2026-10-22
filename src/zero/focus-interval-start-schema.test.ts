import { expect, test } from "vitest";
import { schema } from "./schema.gen.ts";

test("the synced focus interval start exposes ids but never the start time", () => {
	expect(Object.keys(schema.tables.focusIntervalStart.columns).sort()).toEqual([
		"intervalId",
		"userId",
	]);
});
