import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, expect, test, vi } from "vitest";
import type { Fetcher } from "../cli/client.ts";
import { createDiteroMcp, mcpConfiguration } from "./server.ts";

const env = {
	DITERO_URL: "https://todo.example.test",
	DITERO_TOKEN: `ditero_pat_${"A".repeat(43)}`,
};
const key = "00000000-0000-4000-8000-000000000001",
	state = "a".repeat(64);
const update = {
	listId: "list",
	expectedState: state,
	patch: { notes: null, priority: 2 },
};
const deletion = {
	listId: "list",
	expectedState: state,
	expectedChildrenState: { version: 1, count: 0, token: "b".repeat(64) },
	cascadeChildren: false,
};
const task = {
	id: "task",
	listId: "list",
	workspaceId: "home",
	title: "Task",
	notes: null,
	priority: 2,
	done: false,
	dueAt: null,
	dueAllDay: false,
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
	taskId: "task",
	listId: "list",
	workspaceId: "home",
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
};
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const fn of close.splice(0).reverse()) await fn();
});
async function protocol(fetcher: Fetcher) {
	const client = new Client(
		{ name: "mutations-test", version: "1" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const handle = serveStdio(
		() => createDiteroMcp(mcpConfiguration(env), fetcher),
		{ transport: st },
	);
	close.push(async () => {
		await client.close();
		await handle.close();
	});
	await client.connect(ct);
	return client;
}
test("four task tools advertise strict observed contracts and honest mutation annotations", async () => {
	const client = await protocol(vi.fn());
	const tools = (await client.listTools()).tools;
	for (const name of [
		"get_task_observation",
		"get_task_deletion_observation",
		"update_task",
		"delete_task",
	]) {
		const tool = tools.find((t) => t.name === name);
		expect(tool).toBeDefined();
		expect(tool?.inputSchema.additionalProperties).toBe(false);
		expect(tool?.outputSchema?.additionalProperties).toBe(false);
		expect(tool?.annotations).toMatchObject({
			readOnlyHint: name.startsWith("get_"),
			destructiveHint: !name.startsWith("get_"),
			idempotentHint: true,
			openWorldHint: true,
		});
	}
	expect(tools.find((t) => t.name === "update_task")?.description).toContain(
		"without reading a replacement token",
	);
	expect(tools.find((t) => t.name === "delete_task")?.description).toContain(
		"even if the task ID is recreated",
	);
});
test.each([
	false,
	true,
])("observation tool preserves full scalar/child state (%s)", async (deletionRead) => {
	const data = {
		snapshot,
		stateToken: state,
		...(deletionRead ? { childrenState: deletion.expectedChildrenState } : {}),
	};
	const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
		expect(init.method).toBe("GET");
		expect(url.pathname).toBe(
			`/api/v1/tasks/task/${deletionRead ? "deletion-observation" : "observation"}`,
		);
		return Response.json({ version: 1, data, nextCursor: null });
	});
	const client = await protocol(fetcher);
	const r = await client.callTool({
		name: deletionRead
			? "get_task_deletion_observation"
			: "get_task_observation",
		arguments: { taskId: "task" },
	});
	expect(r.structuredContent).toEqual({ version: 1, data, nextCursor: null });
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each([
	"update_task",
	"delete_task",
])("%s sends one exact-key mutation without discovery", async (name) => {
	const body = name === "update_task" ? update : deletion;
	const data =
		name === "update_task"
			? task
			: { taskId: "task", listId: "list", deleted: true, deletedChildren: 0 };
	const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
		expect(url.pathname).toBe("/api/v1/tasks/task");
		expect(init.method).toBe(name === "update_task" ? "PATCH" : "DELETE");
		expect(new Headers(init.headers).get("idempotency-key")).toBe(key);
		expect(JSON.parse(String(init.body))).toEqual(body);
		return Response.json({ version: 1, data, nextCursor: null });
	});
	const client = await protocol(fetcher);
	const r = await client.callTool({
		name,
		arguments: {
			taskId: "task",
			requestId: key,
			[name === "update_task" ? "update" : "deletion"]: body,
		},
	});
	expect(r.isError).not.toBe(true);
	expect(r.structuredContent).toEqual({ version: 1, data, nextCursor: null });
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each([
	[
		"update_task",
		{
			taskId: "task",
			requestId: key,
			update: { ...update, patch: { done: true } },
		},
	],
	[
		"update_task",
		{
			taskId: "task",
			requestId: key,
			update: { ...update, expectedState: "guess" },
		},
	],
	["update_task", { taskId: "task", requestId: "bad", update }],
	[
		"delete_task",
		{
			taskId: "task",
			requestId: key,
			deletion: { ...deletion, cascadeChildren: undefined },
		},
	],
	[
		"delete_task",
		{
			taskId: "task",
			requestId: key,
			deletion: {
				...deletion,
				expectedChildrenState: { version: 1, count: 0 },
			},
		},
	],
	[
		"delete_task",
		{ taskId: "task", requestId: key, deletion, server: env.DITERO_URL },
	],
	["get_task_observation", { taskId: "task", requestId: key }],
	["get_task_deletion_observation", { taskId: "task", limit: 1 }],
])("%s refuses malformed or authority-expanding input before network", async (name, args) => {
	const fetcher = vi.fn();
	const client = await protocol(fetcher);
	let refused = false;
	try {
		refused =
			(await client.callTool({ name, arguments: args })).isError === true;
	} catch {
		refused = true;
	}
	expect(refused).toBe(true);
	expect(fetcher).not.toHaveBeenCalled();
});
test.each([
	"update_task",
	"delete_task",
])("%s preserves stale/revoked/deleted failures and uncertain same-body retry", async (name) => {
	const body = name === "update_task" ? update : deletion;
	const args = {
		taskId: "task",
		requestId: key,
		[name === "update_task" ? "update" : "deletion"]: body,
	};
	for (const status of [401, 403, 409, 410]) {
		const fetcher = vi.fn(
			async () => new Response(env.DITERO_TOKEN, { status }),
		);
		const client = await protocol(fetcher);
		const r = await client.callTool({ name, arguments: args });
		expect(r.isError).toBe(true);
		expect(r.structuredContent).toMatchObject({ error: { status } });
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(r)).not.toContain(env.DITERO_TOKEN);
	}
	const fetcher = vi.fn(async (_url: URL, _init: RequestInit) => {
		throw new Error(env.DITERO_TOKEN);
	});
	const client = await protocol(fetcher);
	expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
	expect(fetcher).toHaveBeenCalledTimes(1);
	await client.callTool({ name, arguments: args });
	expect(fetcher).toHaveBeenCalledTimes(2);
	expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
	expect(
		new Headers(fetcher.mock.calls[1][1].headers).get("idempotency-key"),
	).toBe(key);
});
