import { describe, expect, test } from "vitest";
import { privateNoteVisible } from "./WorkspaceSwitcher.tsx";

describe("privateNoteVisible", () => {
	test("shows only while no shared workspace is listed", () => {
		expect(privateNoteVisible([{ kind: "personal" }], false)).toBe(true);
		expect(
			privateNoteVisible([{ kind: "personal" }, { kind: "shared" }], false),
		).toBe(false);
	});

	test("never beside the members entry", () => {
		expect(privateNoteVisible([{ kind: "personal" }], true)).toBe(false);
	});
});
