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
const snapshot = {
	id: "list",
	workspaceId: "workspace",
	ownerId: "owner",
	title: "Original",
	kind: "tasks",
	icon: null,
	folderId: null,
	sortKey: "a0",
	completedDisplay: "sink",
};
const deletion = {
	workspaceId: "workspace",
	expectedState: "a".repeat(64),
	expectedTasksState: { version: 1, count: 2, token: "b".repeat(64) },
	cascadeTasks: true,
};
const args = { listId: "list", requestId: key, deletion };
const ack = { kind: "list-delete-ack", snapshot, deletedTasks: 2 };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	const errors: unknown[] = [];
	for (const close of cleanup.splice(0).reverse()) {
		try {
			await close();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length)
		throw new AggregateError(errors, "Protocol cleanup failed");
});
async function protocol(fetcher: Fetcher) {
	const client = new Client(
		{ name: "list-deletion-tests", version: "1" },
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
test("deletion discovery publishes strict schemas and explicit destructive/idempotent hints", async () => {
	const client = await protocol(vi.fn());
	const tools = (await client.listTools()).tools;
	for (const name of ["get_list_deletion_observation", "delete_list"]) {
		const tool = tools.find((t) => t.name === name);
		expect(tool?.inputSchema.additionalProperties).toBe(false);
		expect(tool?.outputSchema?.additionalProperties).toBe(false);
		expect(tool?.annotations).toMatchObject({
			readOnlyHint: name !== "delete_list",
			destructiveHint: name === "delete_list",
			idempotentHint: true,
		});
	}
});
test("observation and deletion each issue exactly one named request", async () => {
	const requests: { method: unknown; path: string; body: unknown }[] = [];
	const client = await protocol(async (url, init) => {
		requests.push({ method: init.method, path: url.pathname, body: init.body });
		return Response.json({
			version: 1,
			data:
				init.method === "GET"
					? {
							snapshot,
							stateToken: deletion.expectedState,
							tasksState: deletion.expectedTasksState,
						}
					: ack,
			nextCursor: null,
		});
	});
	for (const [name, arguments_] of [
		["get_list_deletion_observation", { listId: "list" }],
		["delete_list", args],
	] as const) {
		const result = await client.callTool({ name, arguments: arguments_ });
		expect(result.isError).not.toBe(true);
		expect(result.content).toEqual([
			{ type: "text", text: JSON.stringify(result.structuredContent) },
		]);
	}
	expect(requests.map((r) => [r.method, r.path])).toEqual([
		["GET", "/api/v1/lists/list/deletion-observation"],
		["DELETE", "/api/v1/lists/list"],
	]);
	expect(JSON.parse(String(requests[1].body))).toEqual(deletion);
});
test.each([
	{ ...args, listId: "." },
	{ ...args, listId: ".." },
	{ ...args, requestId: "wrong" },
	{ ...args, extra: true },
	{ ...args, deletion: { ...deletion, expectedState: "x".repeat(100000) } },
	{ ...args, deletion: { ...deletion, cascadeTasks: null } },
	{
		...args,
		deletion: {
			...deletion,
			expectedTasksState: { ...deletion.expectedTasksState, extra: true },
		},
	},
])("invalid strict deletion refuses before fetch: %j", async (arguments_) => {
	const fetcher = vi.fn();
	const client = await protocol(fetcher);
	let refused = false;
	try {
		refused =
			(await client.callTool({ name: "delete_list", arguments: arguments_ }))
				.isError === true;
	} catch {
		refused = true;
	}
	expect(refused).toBe(true);
	expect(fetcher).not.toHaveBeenCalled();
});
test.each([
	401, 403, 409, 503,
])("API refusal %s stays explicit without reads or retries", async (status) => {
	const fetcher = vi.fn(async () => new Response(env.DITERO_TOKEN, { status }));
	const client = await protocol(fetcher);
	const result = await client.callTool({
		name: "delete_list",
		arguments: args,
	});
	expect(result.isError).toBe(true);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(JSON.stringify(result)).not.toContain(env.DITERO_TOKEN);
});
test.each([
	{ ...ack, deletedTasks: 1 },
	{ ...ack, snapshot: { ...snapshot, id: "replacement" } },
	{ ...ack, snapshot: { ...snapshot, workspaceId: "other" } },
	{ ...ack, extra: true },
])("historical acknowledgement mismatch fails closed: %j", async (response) => {
	const client = await protocol(async () =>
		Response.json({ version: 1, data: response, nextCursor: null }),
	);
	const result = await client.callTool({
		name: "delete_list",
		arguments: args,
	});
	expect(result.isError).toBe(true);
	expect(result.structuredContent).toMatchObject({
		error: { code: "invalid_response" },
	});
});
test("uncertain HTTP outcome needs an exact manual retry", async () => {
	const calls: unknown[] = [];
	const client = await protocol(async (_url, init) => {
		calls.push({ method: init.method, body: init.body, headers: init.headers });
		if (calls.length === 1) throw new Error("lost response");
		return Response.json({ version: 1, data: ack, nextCursor: null });
	});
	expect(
		(await client.callTool({ name: "delete_list", arguments: args })).isError,
	).toBe(true);
	expect(calls).toHaveLength(1);
	expect(
		(await client.callTool({ name: "delete_list", arguments: args })).isError,
	).not.toBe(true);
	expect(calls[1]).toEqual(calls[0]);
});

test("descriptor-safe tool validation rejects accessors and oversized known fields before serialization", async () => {
	const spy = vi.spyOn(McpServer.prototype, "registerTool");
	let schema: StandardSchemaWithJSON<unknown, unknown> | undefined;
	try {
		const fetcher = vi.fn();
		createDiteroMcp(mcpConfiguration(env), fetcher);
		const registration = spy.mock.calls.find(
			(call) => call[0] === "delete_list",
		);
		schema = registration?.[1].inputSchema as
			| StandardSchemaWithJSON<unknown, unknown>
			| undefined;
	} finally {
		spy.mockRestore();
	}
	expect(schema).toBeDefined();
	if (!schema) throw new Error("Missing registered deletion schema");
	let invoked = false;
	const accessor = Object.defineProperty({ ...deletion }, "workspaceId", {
		enumerable: true,
		get() {
			invoked = true;
			return "workspace";
		},
	});
	const serialization = vi.spyOn(JSON, "stringify");
	try {
		expect(
			(await schema["~standard"].validate({ ...args, deletion: accessor }))
				.issues,
		).toBeDefined();
		expect(invoked).toBe(false);
		expect(
			(
				await schema["~standard"].validate({
					...args,
					deletion: { ...deletion, expectedState: "x".repeat(100000) },
				})
			).issues,
		).toBeDefined();
		expect(
			(await schema["~standard"].validate({ ...args, extra: true })).issues,
		).toBeDefined();
		const payloads = () =>
			serialization.mock.calls
				.map(([value]) => value)
				.filter(
					(value) =>
						value &&
						typeof value === "object" &&
						!Array.isArray(value) &&
						("listId" in value || "workspaceId" in value),
				);
		expect(payloads()).toEqual([]);
		expect((await schema["~standard"].validate(args)).issues).toBeUndefined();
		expect(payloads()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					workspaceId: deletion.workspaceId,
					expectedTasksState: deletion.expectedTasksState,
				}),
				expect.objectContaining({ listId: args.listId, deletion }),
			]),
		);
	} finally {
		serialization.mockRestore();
	}
});
test("SDK request cancellation reaches the active deletion HTTP signal", async () => {
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
		{ name: "delete_list", arguments: args },
		{ signal: controller.signal },
	);
	const outcome = pending.catch((error) => error);
	await entered;
	controller.abort();
	await stopped;
	await outcome;
	expect(fetcher).toHaveBeenCalledTimes(1);
});
