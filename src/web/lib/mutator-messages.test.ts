import { describe, expect, test, vi } from "vitest";
import { m } from "../../paraglide/messages.js";
import { mutationErrorMessage } from "./mutator-messages.ts";

describe("mutationErrorMessage", () => {
	test("a classified rejection renders its own translated message", () => {
		const out = mutationErrorMessage(
			new Error("label name already exists [code:label_name_taken]"),
			m.mutation_failed,
		);
		expect(out).toBe(m.mutator_error_label_name_taken());
		expect(out).not.toContain("label name already exists");
	});

	test("an unclassified rejection never leaks its raw message", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const raw = new Error("parent in different list");
		expect(mutationErrorMessage(raw, m.mutation_failed)).toBe(
			m.mutation_failed(),
		);
		expect(spy).toHaveBeenCalledWith(raw);
		spy.mockRestore();
	});
});
