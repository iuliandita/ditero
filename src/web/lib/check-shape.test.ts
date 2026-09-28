import { expect, test } from "vitest";
import { checkShapeFor, checkToneFor } from "./check-shape.ts";

test("tasks are round, list items are square", () => {
	expect(checkShapeFor("tasks")).toBe("round");
	expect(checkShapeFor("project")).toBe("round");
	expect(checkShapeFor("habits")).toBe("round");
	expect(checkShapeFor("shopping")).toBe("square");
	expect(checkShapeFor("checklist")).toBe("square");
});

test("only round task boxes carry the priority tone", () => {
	expect(checkToneFor("tasks", 3)).toBe(3);
	expect(checkToneFor("project", 1)).toBe(1);
	expect(checkToneFor("habits", 2)).toBe(2);
	expect(checkToneFor("tasks", null)).toBeNull();
	expect(checkToneFor("tasks", undefined)).toBeNull();
	expect(checkToneFor("shopping", 3)).toBeNull();
	expect(checkToneFor("checklist", 2)).toBeNull();
});
