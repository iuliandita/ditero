import { expect, test, vi } from "vitest";
import { parseArguments } from "./arguments.ts";
import { runCli } from "./index.ts";
import { taskWorkflow } from "./task-workflow.ts";

const env = {
	DITERO_URL: "https://todo.example.test",
	DITERO_TOKEN: `ditero_pat_${"A".repeat(43)}`,
};
const key = "00000000-0000-4000-8000-000000000001";
const state = "a".repeat(64);
const update = {
	listId: "list",
	expectedState: state,
	patch: {
		title: "  New title  ",
		notes: null,
		dueAt: "2026-10-04T14:00:00+02:00",
	},
};
const deletion = {
	listId: "list",
	expectedState: state,
	expectedChildrenState: { version: 1, count: 2, token: "b".repeat(64) },
	cascadeChildren: true,
};
const task = {
	id: "observed/task",
	listId: "list",
	workspaceId: "home",
	title: "New title",
	done: false,
	notes: null,
	dueAt: "2026-10-04T12:00:00.000Z",
	dueAllDay: false,
	priority: 0,
	completedAt: null,
	createdAt: null,
	sortKey: "a0",
	parentId: null,
	quantity: null,
	unit: null,
	category: null,
	rrule: null,
	recurrenceRelative: false,
	reminderTime: null,
	assigneeIds: [],
	labelIds: [],
};
const snapshot = {
	version: 1,
	taskId: task.id,
	listId: "list",
	workspaceId: "home",
	title: "Old title",
	notes: "Keep",
	dueAt: null,
	dueAllDay: false,
	priority: 0,
	createdAt: null,
	done: false,
	completedAt: null,
	listKind: "tasks",
	rrule: null,
	recurrenceRelative: false,
	recurrenceAnchorAt: null,
	recurrenceConsumed: null,
};
function args(command: string) {
	return [
		command,
		"--task",
		task.id,
		...(["update-task", "delete-task"].includes(command)
			? ["--request-id", key]
			: []),
		"--json",
	];
}
async function run(
	command: string,
	raw: unknown,
	fetcher: Parameters<typeof runCli>[3],
	argv = args(command),
) {
	const stdout = vi.fn(),
		stderr = vi.fn();
	const reader = vi.fn(async () =>
		raw instanceof Uint8Array
			? raw
			: new TextEncoder().encode(JSON.stringify(raw)),
	);
	const exit = await runCli(argv, env, { stdout, stderr }, fetcher, reader);
	return { exit, stdout, stderr, reader };
}
test.each([
	"observe-task",
	"observe-task-deletion",
])("%s returns the full strict observation without reading stdin", async (command) => {
	const data = {
		snapshot,
		stateToken: state,
		...(command === "observe-task-deletion"
			? { childrenState: deletion.expectedChildrenState }
			: {}),
	};
	const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
		expect(url.pathname).toBe(
			`/api/v1/tasks/observed%2Ftask/${command === "observe-task" ? "observation" : "deletion-observation"}`,
		);
		expect(url.search).toBe("");
		expect(init.method).toBe("GET");
		expect(init.body).toBeUndefined();
		return Response.json({ version: 1, data, nextCursor: null });
	});
	const result = await run(command, undefined, fetcher);
	expect(result.exit).toBe(0);
	expect(result.reader).not.toHaveBeenCalled();
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(JSON.parse(result.stdout.mock.calls[0][0])).toEqual({
		version: 1,
		data,
		nextCursor: null,
	});
});
test("update sends one normalized PATCH while preserving omitted versus null fields", async () => {
	const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
		expect(url.pathname).toBe("/api/v1/tasks/observed%2Ftask");
		expect(init.method).toBe("PATCH");
		expect(JSON.parse(String(init.body))).toEqual({
			...update,
			patch: {
				title: "New title",
				notes: null,
				dueAt: "2026-10-04T12:00:00.000Z",
			},
		});
		expect(new Headers(init.headers).get("idempotency-key")).toBe(key);
		return Response.json({ version: 1, data: task, nextCursor: null });
	});
	const result = await run("update-task", update, fetcher);
	expect(result.exit).toBe(0);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(JSON.parse(result.stdout.mock.calls[0][0]).data).toEqual(task);
});
test("deletion sends the explicit observed cascade and preserves original receipt DTO", async () => {
	const data = {
		taskId: task.id,
		listId: "list",
		deleted: true,
		deletedChildren: 2,
	};
	const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
		expect(init.method).toBe("DELETE");
		expect(JSON.parse(String(init.body))).toEqual(deletion);
		return Response.json({ version: 1, data, nextCursor: null });
	});
	const result = await run("delete-task", deletion, fetcher);
	expect(result.exit).toBe(0);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(JSON.parse(result.stdout.mock.calls[0][0]).data).toEqual(data);
});
test.each([
	"observe-task",
	"observe-task-deletion",
	"update-task",
	"delete-task",
])("%s rejects discovery flags, missing task and inappropriate retry keys before transport", async (command) => {
	for (const argv of [
		[...args(command), "--all"],
		[...args(command), "--limit", "1"],
		[...args(command), "--workspace", "home"],
		[...args(command), "--cursor", "x"],
		[command, "--json"],
		...(!command.startsWith("observe")
			? [[command, "--task", task.id, "--request-id", "bad"]]
			: [[...args(command), "--request-id", key]]),
	]) {
		const fetcher = vi.fn();
		const result = await run(command, update, fetcher, argv);
		expect(result.exit).toBe(2);
		expect(fetcher).not.toHaveBeenCalled();
	}
});
test.each([
	["update-task", { ...update, patch: {} }],
	["update-task", { ...update, expectedState: "new" }],
	["update-task", { ...update, patch: { done: true } }],
	["update-task", { ...update, patch: { title: null } }],
	["delete-task", { ...deletion, cascadeChildren: undefined }],
	[
		"delete-task",
		{ ...deletion, expectedChildrenState: { version: 1, count: 2 } },
	],
	["delete-task", { ...deletion, cascadeChildren: "true" }],
	["update-task", new Uint8Array([255])],
	[
		"update-task",
		new TextEncoder().encode(
			'{"listId":"list","expectedState":"' +
				state +
				'","patch":{"__proto__":{}}}',
		),
	],
	[
		"delete-task",
		new TextEncoder().encode(JSON.stringify(deletion) + " ".repeat(4096)),
	],
	["update-task", new Uint8Array(65537)],
])("%s rejects unsafe, malformed or oversized mutation input", async (command, raw) => {
	const fetcher = vi.fn();
	const result = await run(command, raw, fetcher);
	expect(result.exit).toBe(2);
	expect(fetcher).not.toHaveBeenCalled();
});
test.each([
	"update-task",
	"delete-task",
])("%s preserves conflict, revocation, deleted and uncertain outcomes with one request", async (command) => {
	for (const [status, exit] of [
		[401, 3],
		[403, 4],
		[409, 10],
		[410, 11],
	]) {
		const fetcher = vi.fn(
			async () => new Response(env.DITERO_TOKEN, { status }),
		);
		const r = await run(
			command,
			command === "update-task" ? update : deletion,
			fetcher,
		);
		expect(r.exit).toBe(exit);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(r.stdout).not.toHaveBeenCalled();
		expect(r.stderr.mock.calls[0][0]).not.toContain(env.DITERO_TOKEN);
	}
	const fetcher = vi.fn(async () => {
		throw new Error(env.DITERO_TOKEN);
	});
	const r = await run(
		command,
		command === "update-task" ? update : deletion,
		fetcher,
	);
	expect(r.exit).toBe(7);
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each([
	"update-task",
	"delete-task",
])("%s rejects unexpected 201 and malformed DTOs without retry", async (command) => {
	for (const response of [
		Response.json(
			{ version: 1, data: task, nextCursor: null },
			{ status: 201 },
		),
		Response.json({
			version: 1,
			data: { ...task, secret: true },
			nextCursor: null,
		}),
	]) {
		const fetcher = vi.fn(async () => response);
		const r = await run(
			command,
			command === "update-task" ? update : deletion,
			fetcher,
		);
		expect(r.exit).not.toBe(0);
		expect(r.stdout).not.toHaveBeenCalled();
		expect(fetcher).toHaveBeenCalledTimes(1);
	}
});
test("caller cancellation prevents the mutation request", async () => {
	const options = parseArguments(args("update-task"), env);
	if (!options) throw new Error("Expected mutation options");
	const controller = new AbortController();
	controller.abort();
	const fetcher = vi.fn();
	await expect(
		taskWorkflow(
			options,
			fetcher,
			async () => new TextEncoder().encode(JSON.stringify(update)),
			controller.signal,
		),
	).rejects.toMatchObject({ code: "cancelled" });
	expect(fetcher).not.toHaveBeenCalled();
});
