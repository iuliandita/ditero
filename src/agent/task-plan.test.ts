import { describe, expect, it } from "vitest";
import { planTask, TaskPlanError, type TaskPlanSnapshot } from "./task-plan.ts";

const fixture = (): TaskPlanSnapshot => ({
	profile: {
		id: "me",
		name: "Me",
		timezone: "Europe/Berlin",
		timezoneChosen: true,
		locale: "en",
		serverTime: "2026-10-24T22:30:00Z",
		tokenAccess: "write",
	},
	workspaces: [
		{
			id: "private",
			name: "Private",
			kind: "personal",
			ownerId: "me",
			role: "owner",
		},
	],
	lists: [
		{
			id: "inbox",
			workspaceId: "private",
			ownerId: "me",
			title: "Inbox",
			kind: "tasks",
			icon: null,
			folderId: null,
			sortKey: "a0",
			completedDisplay: "sink",
		},
	],
	people: [
		{ id: "alex", name: "Alex", image: null, workspaceIds: ["private"] },
	],
	labels: [
		{ id: "coffee", workspaceId: "private", name: "Coffee", color: "#abcdef" },
	],
	views: [],
	dashboards: [
		{
			id: "home",
			ownerId: "me",
			workspaceId: null,
			scope: "personal",
			name: "Home",
			icon: null,
			panels: [
				{
					id: "tasks",
					type: "tasks",
					size: "full",
					source: {
						kind: "inline",
						workspaceScope: { mode: "one", id: "private" },
						sort: { field: "dueAt", dir: "asc" },
						filter: {
							op: "and",
							conditions: [{ field: "list", operator: "eq", value: "inbox" }],
						},
					},
				},
			],
		},
	],
});
const intent = () => ({
	title: "Buy coffee",
	target: { kind: "dashboard", selector: { name: "Home" }, personal: true },
	due: { day: "tomorrow" },
	assignees: [{ name: "Alex" }],
	labels: [{ name: "Coffee" }],
});
function code(run: () => unknown, expected: string) {
	try {
		run();
		throw new Error("Expected plan refusal");
	} catch (error) {
		expect(error).toBeInstanceOf(TaskPlanError);
		expect((error as TaskPlanError).code).toBe(expected);
	}
}

describe("agent task planning", () => {
	it("resolves a private dashboard, tomorrow in account time, and explicit assignment/label meaning", () => {
		const plan = planTask(intent(), fixture());
		expect(plan.task).toEqual({
			listId: "inbox",
			title: "Buy coffee",
			notes: null,
			dueAt: "2026-10-26T11:00:00.000Z",
			dueAllDay: true,
			priority: 0,
			assigneeIds: ["alex"],
			labelIds: ["coffee"],
		});
		expect(plan.target).toEqual({ kind: "dashboard", id: "home" });
	});
	it("refuses unscheduled habits for list and dashboard task creation", () => {
		const snapshot = fixture();
		snapshot.lists[0].kind = "habits";
		code(() => planTask(intent(), snapshot), "habit-schedule-required");
		code(
			() =>
				planTask(
					{ ...intent(), target: { kind: "list", selector: { id: "inbox" } } },
					snapshot,
				),
			"habit-schedule-required",
		);
	});
	it("uses the next local calendar day rather than adding 24 hours across DST", () => {
		const snapshot = fixture();
		snapshot.profile.serverTime = "2026-10-24T10:00:00Z";
		expect(planTask(intent(), snapshot).task.dueAt).toBe(
			"2026-10-25T11:00:00.000Z",
		);
	});
	it("resolves an explicit time and rejects nonexistent calendar dates", () => {
		expect(
			planTask(
				{ ...intent(), due: { day: "2026-11-01", time: "09:30" } },
				fixture(),
			).task,
		).toMatchObject({ dueAt: "2026-11-01T08:30:00.000Z", dueAllDay: false });
		code(
			() => planTask({ ...intent(), due: { day: "2026-02-30" } }, fixture()),
			"invalid-due-date",
		);
	});
	it("requires a chosen timezone and write ceiling", () => {
		const snapshot = fixture();
		snapshot.profile.timezoneChosen = false;
		code(() => planTask(intent(), snapshot), "timezone-required");
		snapshot.profile.tokenAccess = "read";
		code(() => planTask(intent(), snapshot), "write-token-required");
	});
	it("returns authorized candidate IDs for duplicate person names, without picking one", () => {
		const snapshot = fixture();
		snapshot.people.push({ ...snapshot.people[0], id: "alex-two" });
		try {
			planTask(intent(), snapshot);
			throw new Error("Expected ambiguity");
		} catch (error) {
			expect(error).toMatchObject({
				code: "ambiguous-assignee",
				choices: [
					{ id: "alex", name: "Alex" },
					{ id: "alex-two", name: "Alex" },
				],
			});
		}
		expect(
			planTask({ ...intent(), assignees: [{ id: "alex" }] }, snapshot).task
				.assigneeIds,
		).toEqual(["alex"]);
	});
	it("refuses nonmember assignment and cross-workspace labels", () => {
		const snapshot = fixture();
		snapshot.people[0].workspaceIds = ["other"];
		code(() => planTask(intent(), snapshot), "assignee-not-found");
		snapshot.people[0].workspaceIds = ["private"];
		snapshot.labels[0].workspaceId = "other";
		code(() => planTask(intent(), snapshot), "label-not-found");
	});
	it("requires a backing list choice for broad dashboard panels", () => {
		const snapshot = fixture();
		snapshot.lists.push({
			...snapshot.lists[0],
			id: "projects",
			title: "Projects",
		});
		const panel = snapshot.dashboards[0].panels[0];
		if (panel.type !== "tasks" || panel.source.kind !== "inline")
			throw new Error("fixture");
		panel.source.filter.conditions = [];
		code(() => planTask(intent(), snapshot), "ambiguous-backing-list");
		expect(
			planTask(
				{ ...intent(), target: { ...intent().target, listId: "projects" } },
				snapshot,
			).task.listId,
		).toBe("projects");
	});
	it("cannot select an explicit list outside the panel's permitted sources", () => {
		const snapshot = fixture();
		snapshot.lists.push({
			...snapshot.lists[0],
			id: "projects",
			title: "Projects",
		});
		code(
			() =>
				planTask(
					{ ...intent(), target: { ...intent().target, listId: "projects" } },
					snapshot,
				),
			"backing-list-not-found",
		);
	});
	it("resolves referenced views and rejects dangling view references", () => {
		const snapshot = fixture();
		snapshot.dashboards[0].panels = [
			{
				id: "tasks",
				type: "tasks",
				size: "full",
				source: { kind: "view", viewId: "saved" },
			},
		];
		code(() => planTask(intent(), snapshot), "dashboard-view-unavailable");
		snapshot.views.push({
			id: "saved",
			ownerId: "me",
			workspaceId: null,
			scope: "personal",
			name: "Inbox",
			icon: null,
			filter: {
				op: "and",
				conditions: [{ field: "list", operator: "eq", value: "inbox" }],
			},
			display: {
				layout: "list",
				groupBy: "none",
				sort: { field: "dueAt", dir: "asc" },
				workspaceScope: { mode: "one", id: "private" },
			},
		});
		expect(planTask(intent(), snapshot).task.listId).toBe("inbox");
	});
	it("refuses a task that would not appear in the chosen dashboard", () => {
		const snapshot = fixture();
		const panel = snapshot.dashboards[0].panels[0];
		if (panel.type !== "tasks" || panel.source.kind !== "inline")
			throw new Error("fixture");
		panel.source.filter.conditions.push({
			field: "priority",
			operator: "eq",
			value: 3,
		});
		code(() => planTask(intent(), snapshot), "dashboard-filter-mismatch");
		expect(planTask({ ...intent(), priority: 3 }, snapshot).task.priority).toBe(
			3,
		);
	});
	it("does not silently narrow an OR filter to its list branch", () => {
		const snapshot = fixture();
		snapshot.lists.push({
			...snapshot.lists[0],
			id: "projects",
			title: "Projects",
		});
		const panel = snapshot.dashboards[0].panels[0];
		if (panel.type !== "tasks" || panel.source.kind !== "inline")
			throw new Error("fixture");
		panel.source.filter = {
			op: "or",
			conditions: [
				{ field: "list", operator: "eq", value: "inbox" },
				{ field: "priority", operator: "eq", value: 3 },
			],
		};
		code(() => planTask(intent(), snapshot), "ambiguous-backing-list");
	});
	it("refuses viewer destinations and shared targets when private is requested", () => {
		const snapshot = fixture();
		snapshot.workspaces[0].role = "viewer";
		code(() => planTask(intent(), snapshot), "backing-list-not-found");
		snapshot.workspaces[0].role = "member";
		snapshot.workspaces[0].kind = "shared";
		code(() => planTask(intent(), snapshot), "backing-list-not-found");
	});
	it("keeps duplicate IDs, unknown tag semantics and invitations explicit", () => {
		expect(() => planTask({ ...intent(), tag: "Alex" }, fixture())).toThrow();
		expect(() =>
			planTask({ ...intent(), invite: "alex@example.test" }, fixture()),
		).toThrow();
		expect(() =>
			planTask(
				{ ...intent(), assignees: [{ id: "alex" }, { name: "Alex" }] },
				fixture(),
			),
		).toThrow();
	});
});
