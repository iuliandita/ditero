import { describe, expect, it } from "vitest";
import { taskAudience } from "./task-audience.ts";

const me = { userId: "me" };
const other = { userId: "sam" };

describe("taskAudience", () => {
	it.each([
		[
			"a sole member of a personal workspace",
			{ name: "Personal", kind: "personal" },
			[me],
			{ text: "Only you can see this", opensMembers: false },
		],
		[
			"a personal workspace that has another member",
			{ name: "Personal", kind: "personal" },
			[me, other],
			{ text: "Everyone in Personal can see this", opensMembers: true },
		],
		[
			"a shared workspace",
			{ name: "Maple household", kind: "shared" },
			[me, other],
			{
				text: "Everyone in Maple household can see this",
				opensMembers: true,
			},
		],
		[
			"a shared workspace with only the caller",
			{ name: "Maple household", kind: "shared" },
			[me],
			{ text: "Only you can see this", opensMembers: true },
		],
	])("says the right thing for %s", (_label, workspace, members, expected) => {
		expect(taskAudience(workspace, members, "me")).toEqual(expected);
	});

	it.each([
		["unknown workspace", undefined, [me]],
		["memberships not synced yet", { name: "Personal", kind: "personal" }, []],
		[
			"only other people's rows",
			{ name: "Personal", kind: "personal" },
			[other],
		],
	])("makes no claim while %s", (_label, workspace, members) => {
		expect(taskAudience(workspace, members, "me")).toBeNull();
	});
});
