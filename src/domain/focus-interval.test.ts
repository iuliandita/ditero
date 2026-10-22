import { expect, test } from "vitest";
import { isFocusDuplicate } from "./focus-interval.ts";

const message =
	'duplicate key value violates unique constraint "focus_session_pkey"';

test.each([
	[
		"PostgreSQL fields without a message",
		{ code: "23505", constraint: "focus_session_pkey" },
		true,
	],
	[
		"another PostgreSQL code",
		{ code: "42501", constraint: "focus_session_pkey", message },
		false,
	],
	[
		"another constraint",
		{ code: "23505", constraint: "other_pkey", message },
		false,
	],
	[
		"a PostgreSQL code with the constraint in the message",
		Object.assign(new Error(message), { code: "23505" }),
		true,
	],
	["a transported string", message, true],
	["an unrelated error", new Error("relation does not exist"), false],
])("focus duplicate detection handles %s", (_name, error, expected) => {
	expect(isFocusDuplicate(error)).toBe(expected);
});
