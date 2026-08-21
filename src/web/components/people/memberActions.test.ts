import { describe, expect, test } from "vitest";
import { visibleActions } from "../ui/row-action.ts";
import { memberActions } from "./memberActions.ts";

// The rule matrix itself is covered by tests/integration/memberships.test.ts;
// this is the one real client-side property worth its own test -- a caller
// with no admin standing must never see an action that would only fail.
describe("memberActions", () => {
	test("a viewer caller sees zero visible actions on any row", () => {
		const actions = memberActions({
			membershipId: "m1",
			memberName: "Someone",
			memberRole: "member",
			isSelf: false,
			callerRole: "viewer",
			ownerCount: 2,
			handlers: { setRole: () => {}, remove: () => {} },
		});
		expect(visibleActions(actions)).toEqual([]);
	});
});
