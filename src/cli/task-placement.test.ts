import { expect, test, vi } from "vitest";
import { parseArguments } from "./arguments.ts";
import { discover } from "./client.ts";
import { runCli } from "./index.ts";
import {
	encodeTaskPlacementInput,
	taskPlacementWorkflow,
} from "./task-placement-workflow.ts";

const env = {
	DITERO_URL: "https://todo.example.test",
	DITERO_TOKEN: `ditero_pat_${"A".repeat(43)}`,
};
const key = "00000000-0000-4000-8000-000000000001";
const placement = {
	workspaceId: "workspace",
	listId: "list",
	expectedState: "a".repeat(64),
	targetListId: "list",
	expectedTargetState: "b".repeat(64),
	sortKey: "a1",
	cascadeChildren: false,
	expectedChildrenState: null,
};
const snapshot = {
	version: 1,
	task: {
		version: 1,
		taskId: "task",
		listId: "list",
		workspaceId: "workspace",
		title: "Task",
		notes: null,
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
	},
	sortKey: "a1",
	parentId: null,
	list: {
		id: "list",
		workspaceId: "workspace",
		ownerId: "owner",
		title: "List",
		kind: "tasks",
		icon: null,
		folderId: null,
		sortKey: "a0",
		completedDisplay: "sink",
	},
};
const children = { version: 1, count: 0, token: "c".repeat(64) };
const ack = {
	kind: "task-place-ack",
	originalWorkspaceId: "workspace",
	originalListId: "list",
	movedChildren: 0,
	snapshot,
};
const observation = {
	snapshot,
	stateToken: placement.expectedState,
	childrenState: children,
};

function options(command = "place-task", id = "task") {
	const value = parseArguments(
		[
			command,
			"--task",
			id,
			...(command === "place-task" ? ["--request-id", key] : []),
		],
		env,
	);
	if (!value) throw new Error("Missing options");
	return value;
}
const envelope = (data: unknown) =>
	Response.json({ version: 1, data, nextCursor: null });
test("observation is one encoded GET without stdin, key or hidden target read", async () => {
	const reader = vi.fn();
	const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
		expect(url.pathname).toBe(
			"/api/v1/tasks/task%2Fpart/placement-observation",
		);
		expect(init.method).toBe("GET");
		expect(init.headers).not.toHaveProperty("idempotency-key");
		return envelope({
			...observation,
			snapshot: {
				...snapshot,
				task: { ...snapshot.task, taskId: "task/part" },
			},
		});
	});
	await taskPlacementWorkflow(
		options("observe-task-placement", "task/part"),
		fetcher,
		reader,
	);
	expect(reader).not.toHaveBeenCalled();
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each([
	0, 2,
])("relocation explicitly acknowledges %s children and exact target", async (count) => {
	const input = {
		...placement,
		targetListId: "target",
		cascadeChildren: true,
		expectedChildrenState: { ...children, count },
	};
	const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
		expect(url.pathname).toBe("/api/v1/tasks/task/placement");
		expect(init).toMatchObject({
			method: "PATCH",
			headers: { "idempotency-key": key },
		});
		expect(JSON.parse(String(init.body))).toEqual(input);
		return envelope({
			...ack,
			movedChildren: count,
			snapshot: {
				...snapshot,
				task: { ...snapshot.task, listId: "target" },
				list: { ...snapshot.list, id: "target" },
			},
		});
	});
	await taskPlacementWorkflow(options(), fetcher, async () =>
		encodeTaskPlacementInput(input),
	);
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each([
	new Uint8Array([255]),
	new TextEncoder().encode(" ".repeat(4097)),
	{ ...placement, extra: true },
	{ ...placement, expectedTargetState: undefined },
	{ ...placement, targetListId: "target" },
	{ ...placement, cascadeChildren: true },
	{ ...placement, sortKey: "a10" },
])("bad placement refuses before request: %j", async (input) => {
	const fetcher = vi.fn(),
		stdout = vi.fn(),
		stderr = vi.fn();
	expect(
		await runCli(
			["place-task", "--task", "task", "--request-id", key],
			env,
			{ stdout, stderr },
			fetcher,
			async () =>
				input instanceof Uint8Array
					? input
					: new TextEncoder().encode(JSON.stringify(input)),
		),
	).toBe(2);
	expect(fetcher).not.toHaveBeenCalled();
});
test("nested descriptors/prototypes/symbols fail without evaluating getters", () => {
	let invoked = false;
	const hostile = Object.defineProperty({ ...children }, "count", {
		enumerable: true,
		get() {
			invoked = true;
			return 0;
		},
	});
	for (const input of [
		Object.create(placement),
		{ ...placement, [Symbol("x")]: true },
		{
			...placement,
			targetListId: "target",
			cascadeChildren: true,
			expectedChildrenState: hostile,
		},
	])
		expect(() => encodeTaskPlacementInput(input)).toThrow();
	expect(invoked).toBe(false);
});
test.each([
	{ ...ack, originalListId: "other" },
	{ ...ack, originalWorkspaceId: "other" },
	{ ...ack, movedChildren: 1 },
	{ ...ack, snapshot: { ...snapshot, sortKey: "a2" } },
	{
		...ack,
		snapshot: { ...snapshot, task: { ...snapshot.task, taskId: "other" } },
	},
	{
		...ack,
		snapshot: {
			...snapshot,
			task: { ...snapshot.task, listId: "other" },
			list: { ...snapshot.list, id: "other" },
		},
	},
])("ack must match original request and effect: %j", async (data) => {
	await expect(
		taskPlacementWorkflow(
			options(),
			async () => envelope(data),
			async () => encodeTaskPlacementInput(placement),
		),
	).rejects.toMatchObject({ code: "invalid_response" });
});
test("manual uncertain retry retains identical key/body without an internal retry", async () => {
	const calls: RequestInit[] = [];
	const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
		calls.push(init);
		if (calls.length === 1) throw new Error("lost");
		return envelope(ack);
	});
	await expect(
		taskPlacementWorkflow(options(), fetcher, async () =>
			encodeTaskPlacementInput(placement),
		),
	).rejects.toMatchObject({ code: "network_error" });
	expect(calls).toHaveLength(1);
	await taskPlacementWorkflow(options(), fetcher, async () =>
		encodeTaskPlacementInput(placement),
	);
	expect(calls[1].body).toBe(calls[0].body);
	expect(calls[1].headers).toEqual(calls[0].headers);
});
test.each([
	401, 403, 404, 409, 429, 503,
])("HTTP %s remains one explicit refusal", async (status) => {
	const fetcher = vi.fn(async () => new Response("refused", { status }));
	await expect(
		taskPlacementWorkflow(options(), fetcher, async () =>
			encodeTaskPlacementInput(placement),
		),
	).rejects.toMatchObject({ status });
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test("cancellation reaches request and no retry", async () => {
	const controller = new AbortController();
	const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
		controller.abort();
		expect(init.signal?.aborted).toBe(true);
		throw new Error("abort");
	});
	await expect(
		taskPlacementWorkflow(
			options(),
			fetcher,
			async () => encodeTaskPlacementInput(placement),
			controller.signal,
		),
	).rejects.toMatchObject({ code: "cancelled" });
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each([
	"observe-task-placement",
	"place-task",
])("discover refuses workflow %s", async (command) => {
	const fetcher = vi.fn();
	await expect(discover(options(command), fetcher)).rejects.toMatchObject({
		code: "invalid_arguments",
	});
	expect(fetcher).not.toHaveBeenCalled();
});
test.each([".", ".."])("dot path %s refuses before HTTP", async (id) => {
	const fetcher = vi.fn();
	await expect(
		taskPlacementWorkflow(options("place-task", id), fetcher, async () =>
			encodeTaskPlacementInput(placement),
		),
	).rejects.toMatchObject({ code: "invalid_input" });
	expect(fetcher).not.toHaveBeenCalled();
});

test.each([
	"observe-task-placement",
	"place-task",
])("%s refuses lone surrogate task IDs before stdin or HTTP", async (command) => {
	for (const id of ["task\uD800", "task\uDFFF"]) {
		const fetcher = vi.fn();
		const reader = vi.fn();
		await expect(
			taskPlacementWorkflow(options(command, id), fetcher, reader),
		).rejects.toMatchObject({ code: "invalid_input" });
		expect(reader).not.toHaveBeenCalled();
		expect(fetcher).not.toHaveBeenCalled();
	}
});
