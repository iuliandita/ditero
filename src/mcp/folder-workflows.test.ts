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
	id: "folder",
	workspaceId: "ws",
	name: "Projects",
	sortKey: "a0",
};
const observation = { snapshot, stateToken: "a".repeat(64) };
const create = { workspaceId: "ws", name: "Projects" };
const update = {
	workspaceId: "ws",
	expectedState: observation.stateToken,
	patch: { name: "Renamed" },
};
const deletion = { workspaceId: "ws", expectedState: observation.stateToken };
const args = { requestId: key, folder: create };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	const errors: unknown[] = [];
	for (const close of cleanup.splice(0).reverse())
		try {
			await close();
		} catch (error) {
			errors.push(error);
		}
	if (errors.length)
		throw new AggregateError(errors, "Protocol cleanup failed");
});
async function protocol(fetcher: Fetcher) {
	const client = new Client(
		{ name: "comment-tests", version: "1" },
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

test("four SDK folder tools perform matching HTTP methods and paths", async () => {
	const calls: { path: string; method: string }[] = [];
	const client = await protocol(async (url, init) => {
		calls.push({ path: url.pathname, method: init.method ?? "GET" });
		return Response.json({
			version: 1,
			data:
				init.method === "GET"
					? observation
					: {
							kind:
								init.method === "POST"
									? "folder-create-ack"
									: init.method === "PATCH"
										? "folder-update-ack"
										: "folder-delete-ack",
							snapshot:
								init.method === "PATCH"
									? { ...snapshot, name: "Renamed" }
									: snapshot,
						},
			nextCursor: null,
		});
	});
	for (const [name, arguments_] of [
		["get_folder_observation", { folderId: "folder" }],
		["create_folder", args],
		["update_folder", { folderId: "folder", requestId: key, folder: update }],
		["delete_folder", { folderId: "folder", requestId: key, folder: deletion }],
	] as const) {
		const result = await client.callTool({ name, arguments: arguments_ });
		expect(result.isError).not.toBe(true);
		expect(result.content).toEqual([
			{ type: "text", text: JSON.stringify(result.structuredContent) },
		]);
	}
	expect(calls).toEqual([
		{ path: "/api/v1/folders/folder/observation", method: "GET" },
		{ path: "/api/v1/folders", method: "POST" },
		{ path: "/api/v1/folders/folder", method: "PATCH" },
		{ path: "/api/v1/folders/folder", method: "DELETE" },
	]);
	expect((await client.listTools()).tools).toHaveLength(37);
});
test.each([
	["get_folder_observation", { folderId: ".." }],
	["get_folder_observation", { folderId: "\uD800" }],
	["get_folder_observation", { folderId: "folder", all: true }],
	["create_folder", { ...args, requestId: "bad" }],
	["create_folder", { ...args, folder: { ...create, name: "x".repeat(501) } }],
	[
		"delete_folder",
		{
			folderId: "folder",
			requestId: key,
			folder: { ...deletion, cascade: true },
		},
	],
	[
		"update_folder",
		{
			folderId: "folder",
			requestId: key,
			folder: { ...update, expectedState: "A".repeat(64) },
		},
	],
])("%s refuses invalid arguments before wire", async (name, arguments_) => {
	const fetcher = vi.fn(),
		client = await protocol(fetcher);
	let refused = false;
	try {
		refused =
			(await client.callTool({ name, arguments: arguments_ })).isError === true;
	} catch {
		refused = true;
	}
	expect(refused).toBe(true);
	expect(fetcher).not.toHaveBeenCalled();
});
test("registered folder schema rejects getters without invoking them", async () => {
	const spy = vi.spyOn(McpServer.prototype, "registerTool");
	let schema: StandardSchemaWithJSON<unknown, unknown> | undefined;
	try {
		createDiteroMcp(mcpConfiguration(env), vi.fn());
		schema = spy.mock.calls.find((call) => call[0] === "create_folder")?.[1]
			.inputSchema as unknown as StandardSchemaWithJSON<unknown, unknown>;
	} finally {
		spy.mockRestore();
	}
	if (!schema) throw new Error("Missing folder schema");
	const getter = vi.fn(() => create);
	for (const value of [
		Object.defineProperty({ ...args }, "folder", {
			enumerable: true,
			get: getter,
		}),
		{
			...args,
			folder: Object.defineProperty({ ...create }, "name", {
				enumerable: true,
				get: getter,
			}),
		},
		Object.create(args),
	])
		expect((await schema["~standard"].validate(value)).issues).toBeDefined();
	expect(getter).not.toHaveBeenCalled();
	expect((await schema["~standard"].validate(args)).issues).toBeUndefined();
});
test("SDK uncertainty preserves exact caller payload for explicit retry", async () => {
	const bodies: unknown[] = [];
	const client = await protocol(async (_url, init) => {
		bodies.push(init.body);
		if (bodies.length === 1) throw new Error("lost");
		return Response.json({
			version: 1,
			data: { kind: "folder-create-ack", snapshot },
			nextCursor: null,
		});
	});
	expect(
		(await client.callTool({ name: "create_folder", arguments: args })).isError,
	).toBe(true);
	expect(bodies).toHaveLength(1);
	expect(
		(await client.callTool({ name: "create_folder", arguments: args })).isError,
	).not.toBe(true);
	expect(bodies[1]).toBe(bodies[0]);
});

test("SDK cancellation propagates to the single active folder write", async () => {
	let entered!: () => void, stopped!: () => void;
	const started = new Promise<void>((resolve) => {
			entered = resolve;
		}),
		aborted = new Promise<void>((resolve) => {
			stopped = resolve;
		});
	const fetcher = vi.fn(
		async (_url: URL, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				if (!init.signal) throw new Error("Missing signal");
				init.signal.addEventListener(
					"abort",
					() => {
						stopped();
						reject(new Error("abort"));
					},
					{ once: true },
				);
				entered();
			}),
	);
	const client = await protocol(fetcher),
		controller = new AbortController();
	const pending = client
		.callTool(
			{ name: "create_folder", arguments: args },
			{ signal: controller.signal },
		)
		.catch((error) => error);
	await started;
	controller.abort();
	await aborted;
	await pending;
	expect(fetcher).toHaveBeenCalledTimes(1);
});
