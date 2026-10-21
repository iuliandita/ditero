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
			workspaceKind: "shared",
			handlers: { setRole: () => {}, remove: () => {}, leave: () => {} },
		});
		expect(visibleActions(actions)).toEqual([]);
	});

	test.each([
		"member",
		"owner",
	] as const)("a personal workspace owner can only remove a legacy %s", (memberRole) => {
		const actions = memberActions({
			membershipId: "legacy",
			memberName: "Legacy member",
			memberRole,
			isSelf: false,
			callerRole: "owner",
			ownerCount: 2,
			workspaceKind: "personal",
			callerOwnsWorkspace: true,
			handlers: { setRole: () => {}, remove: () => {}, leave: () => {} },
		});
		expect(visibleActions(actions).map((action) => action.id)).toEqual([
			"remove",
		]);
	});

	test.each([
		true,
		false,
	])("personal membership actions protect the owner and reject legacy administrators (self=%s)", (isSelf) => {
		const actions = memberActions({
			membershipId: "m1",
			memberName: "Owner",
			memberRole: "owner",
			isSelf,
			callerRole: "owner",
			ownerCount: 2,
			workspaceKind: "personal",
			callerOwnsWorkspace: isSelf,
			handlers: { setRole: () => {}, remove: () => {}, leave: () => {} },
		});
		expect(visibleActions(actions)).toEqual([]);
	});
});

test.each([
	"member",
	"viewer",
	"admin",
	"owner",
] as const)("%s can leave their own shared workspace", (role) => {
	const actions = memberActions({
		membershipId: "self",
		memberName: "Me",
		memberRole: role,
		isSelf: true,
		callerRole: role,
		ownerCount: 2,
		workspaceKind: "shared",
		handlers: { setRole: () => {}, remove: () => {}, leave: () => {} },
	});
	expect(visibleActions(actions).map((a) => a.id)).toEqual(["leave"]);
	expect(visibleActions(actions)[0].disabledReason).toBeUndefined();
});
test("a sole owner sees the ownership-transfer reason", () => {
	const actions = memberActions({
		membershipId: "self",
		memberName: "Me",
		memberRole: "owner",
		isSelf: true,
		callerRole: "owner",
		ownerCount: 1,
		workspaceKind: "shared",
		handlers: { setRole: () => {}, remove: () => {}, leave: () => {} },
	});
	expect(visibleActions(actions)[0]).toMatchObject({
		id: "leave",
		disabledReason: expect.any(String),
	});
});
