import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
	McpServer,
	type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, expect, test, vi } from "vitest";
import type { Fetcher } from "../cli/client.ts";
import { createDiteroMcp, mcpConfiguration } from "./server.ts";

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

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	const errors: unknown[] = [];
	for (const close of cleanup.splice(0).reverse())
		try {
			await close();
		} catch (e) {
			errors.push(e);
		}
	if (errors.length)
		throw new AggregateError(errors, "Protocol cleanup failed");
});
async function protocol(fetcher: Fetcher) {
	const client = new Client(
		{ name: "placement-tests", version: "1" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const handle = serveStdio(
		() => createDiteroMcp(mcpConfiguration(env), fetcher),
		{ transport: st },
	);
	cleanup.push(
		() => handle.close(),
		() => client.close(),
	);
	await client.connect(ct);
	return client;
}
const args = { taskId: "task", requestId: key, placement };
test("placement tools expose strict schemas and honest annotations", async () => {
	const client = await protocol(vi.fn());
	for (const name of ["get_task_placement_observation", "place_task"]) {
		const tool = (await client.listTools()).tools.find((t) => t.name === name);
		expect(tool?.inputSchema.additionalProperties).toBe(false);
		expect(tool?.annotations).toMatchObject({
			readOnlyHint: name !== "place_task",
			destructiveHint: name === "place_task",
			idempotentHint: true,
		});
	}
});
test("one GET then one PATCH returns matching text and structured immutable ack", async () => {
	const calls: RequestInit[] = [];
	const paths: string[] = [];
	const client = await protocol(async (url, init) => {
		calls.push(init);
		paths.push(url.pathname);
		return Response.json({
			version: 1,
			data: init.method === "GET" ? observation : ack,
			nextCursor: null,
		});
	});
	for (const [name, arguments_] of [
		["get_task_placement_observation", { taskId: "task" }],
		["place_task", args],
	] as const) {
		const result = await client.callTool({ name, arguments: arguments_ });
		expect(result.isError).not.toBe(true);
		expect(result.content).toEqual([
			{ type: "text", text: JSON.stringify(result.structuredContent) },
		]);
	}
	expect(paths).toEqual([
		"/api/v1/tasks/task/placement-observation",
		"/api/v1/tasks/task/placement",
	]);
	expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
	expect(JSON.parse(String(calls[1].body))).toEqual(placement);
	expect(calls[1].headers).toMatchObject({ "idempotency-key": key });
});
test.each([
	{ ...args, extra: true },
	{ ...args, taskId: "." },
	{ ...args, requestId: "bad" },
	{ ...args, placement: { ...placement, targetListId: "target" } },
	{
		...args,
		placement: { ...placement, expectedTargetState: "x".repeat(4097) },
	},
	{ ...args, placement: { ...placement, sortKey: "a10" } },
])("invalid placement refuses before wire: %j", async (arguments_) => {
	const fetcher = vi.fn();
	const client = await protocol(fetcher);
	let refused = false;
	try {
		refused =
			(await client.callTool({ name: "place_task", arguments: arguments_ }))
				.isError === true;
	} catch {
		refused = true;
	}
	expect(refused).toBe(true);
	expect(fetcher).not.toHaveBeenCalled();
});
test.each([
	401, 403, 404, 409, 429, 503,
])("refusal %s remains one wire with sanitized error", async (status) => {
	const fetcher = vi.fn(async () => new Response(env.DITERO_TOKEN, { status }));
	const client = await protocol(fetcher);
	const result = await client.callTool({ name: "place_task", arguments: args });
	expect(result.isError).toBe(true);
	expect(JSON.stringify(result)).not.toContain(env.DITERO_TOKEN);
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test("mismatched replay ack refuses", async () => {
	const client = await protocol(async () =>
		Response.json({
			version: 1,
			data: { ...ack, movedChildren: 1 },
			nextCursor: null,
		}),
	);
	expect(
		(await client.callTool({ name: "place_task", arguments: args })).isError,
	).toBe(true);
});

test("uncertain HTTP outcome needs an exact manual retry", async () => {
	const calls: unknown[] = [];
	const client = await protocol(async (_url, init) => {
		calls.push({ method: init.method, body: init.body, headers: init.headers });
		if (calls.length === 1) throw new Error("lost response");
		return Response.json({ version: 1, data: ack, nextCursor: null });
	});
	expect(
		(
			await client.callTool({
				name: "place_task",
				arguments: args,
			})
		).isError,
	).toBe(true);
	expect(calls).toHaveLength(1);
	expect(
		(
			await client.callTool({
				name: "place_task",
				arguments: args,
			})
		).isError,
	).not.toBe(true);
	expect(calls[1]).toEqual(calls[0]);
});

test("SDK request cancellation reaches the active placement HTTP signal", async () => {
	let started!: () => void, aborted!: () => void;
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	const stopped = new Promise<void>((resolve) => {
		aborted = resolve;
	});
	const fetcher = vi.fn(
		async (_url: URL, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init.signal;
				if (!signal) throw new Error("Missing HTTP signal");
				signal.addEventListener(
					"abort",
					() => {
						aborted();
						reject(new Error("cancelled"));
					},
					{ once: true },
				);
				started();
			}),
	);
	const client = await protocol(fetcher),
		controller = new AbortController();
	const pending = client.callTool(
		{ name: "place_task", arguments: args },
		{ signal: controller.signal },
	);
	const outcome = pending.catch((error) => error);
	await entered;
	controller.abort();
	await stopped;
	await outcome;
	expect(fetcher).toHaveBeenCalledTimes(1);
});

test("registered validation rejects hostile nested/outer descriptors before serialization", async () => {
	const spy = vi.spyOn(McpServer.prototype, "registerTool");
	let schema: StandardSchemaWithJSON<unknown, unknown> | undefined;
	try {
		createDiteroMcp(mcpConfiguration(env), vi.fn());
		schema = spy.mock.calls.find((call) => call[0] === "place_task")?.[1]
			.inputSchema as StandardSchemaWithJSON<unknown, unknown> | undefined;
	} finally {
		spy.mockRestore();
	}
	if (!schema) throw new Error("Missing placement input schema");
	let invoked = false;
	const getter = () => {
		invoked = true;
		throw new Error("getter");
	};
	const payload = Object.defineProperty({ ...placement }, "sortKey", {
		enumerable: true,
		get: getter,
	});
	const outer = Object.defineProperty({ ...args }, "placement", {
		enumerable: true,
		get: getter,
	});
	const child = Object.defineProperty({ ...children }, "count", {
		enumerable: true,
		get: getter,
	});
	for (const value of [
		outer,
		{ ...args, placement: payload },
		{
			...args,
			placement: {
				...placement,
				targetListId: "target",
				cascadeChildren: true,
				expectedChildrenState: child,
			},
		},
		Object.create(args),
		{ ...args, [Symbol("hidden")]: true },
	])
		expect((await schema["~standard"].validate(value)).issues).toBeDefined();
	expect(invoked).toBe(false);
	expect((await schema["~standard"].validate(args)).issues).toBeUndefined();
});

test.each([
	"get_task_placement_observation",
	"place_task",
])("%s reports invalid_input for lone surrogate task IDs without wire requests", async (name) => {
	const fetcher = vi.fn();
	const client = await protocol(fetcher);
	for (const taskId of ["task\uD800", "task\uDFFF"]) {
		const result = await client.callTool({
			name,
			arguments: name === "place_task" ? { ...args, taskId } : { taskId },
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			error: { code: "invalid_input" },
		});
	}
	expect(fetcher).not.toHaveBeenCalled();
});
