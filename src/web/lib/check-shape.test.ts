import { expect, test } from "vitest";
import { checkShapeFor } from "./check-shape.ts";

test("tasks are round, list items are square", () => {
	expect(checkShapeFor("tasks")).toBe("round");
	expect(checkShapeFor("project")).toBe("round");
	expect(checkShapeFor("habits")).toBe("round");
	expect(checkShapeFor("shopping")).toBe("square");
	expect(checkShapeFor("checklist")).toBe("square");
});
