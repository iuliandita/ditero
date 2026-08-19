import { describe, expect, test } from "vitest";
import { ROLES } from "../../../domain/role.ts";
import { canActOnOwned, type RowAction, visibleActions } from "./row-action.ts";

function action(overrides: Partial<RowAction> = {}): RowAction {
	return { id: "a", label: "A", onSelect: () => {}, ...overrides };
}

describe("visibleActions", () => {
	test("drops hidden actions", () => {
		const actions = [
			action({ id: "keep" }),
			action({ id: "gone", hidden: true }),
		];
		expect(visibleActions(actions).map((a) => a.id)).toEqual(["keep"]);
	});

	test("keeps disabled actions, because the reason is the point", () => {
		const actions = [action({ id: "blocked", disabledReason: "not empty" })];
		expect(visibleActions(actions).map((a) => a.id)).toEqual(["blocked"]);
	});

	test("filters submenus recursively", () => {
		const actions = [
			action({
				id: "move",
				submenu: [action({ id: "f1" }), action({ id: "f2", hidden: true })],
			}),
		];
		expect(visibleActions(actions)[0].submenu?.map((a) => a.id)).toEqual([
			"f1",
		]);
	});

	test("drops a submenu parent left with no children", () => {
		const actions = [
			action({ id: "move", submenu: [action({ id: "f1", hidden: true })] }),
		];
		expect(visibleActions(actions)).toEqual([]);
	});
});

describe("canActOnOwned", () => {
	// Mirrors the rule in mutators.ts for list.delete and template.delete:
	// admin+ OR the owner/creator holding a write role.
	test("admins may act on anyone's row", () => {
		for (const role of ["owner", "admin"] as const) {
			expect(canActOnOwned(role, "someone-else", "me")).toBe(true);
		}
	});

	test("a member may act on their own row only", () => {
		expect(canActOnOwned("member", "me", "me")).toBe(true);
		expect(canActOnOwned("member", "someone-else", "me")).toBe(false);
	});

	test("a viewer may never act, not even on their own row", () => {
		expect(canActOnOwned("viewer", "me", "me")).toBe(false);
	});

	test("no role at all may never act", () => {
		expect(canActOnOwned(null, "me", "me")).toBe(false);
	});

	test("an unowned row is admin-only, since nobody can claim it", () => {
		for (const role of ROLES) {
			expect(canActOnOwned(role, null, "me")).toBe(
				role === "owner" || role === "admin",
			);
		}
	});

	test("every role is covered by exactly one branch", () => {
		const allowedOnOwn = ROLES.filter((r) => canActOnOwned(r, "me", "me"));
		expect(allowedOnOwn).toEqual(["owner", "admin", "member"]);
	});
});
