import { describe, expect, test, vi } from "vitest";
import { MutatorError } from "../../domain/mutator-error.ts";
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

test("guardian rejection names the managed accounts in a translated action", () => {
	const error = new MutatorError(
		"guardian_has_managed_members",
		"remove managed accounts first",
		["Maya", "Alex"],
	);
	expect(mutationErrorMessage(error.message, m.mutation_failed)).toBe(
		"Remove these managed accounts from this workspace first: Maya and Alex. Then remove their guardian or leave.",
	);
});
