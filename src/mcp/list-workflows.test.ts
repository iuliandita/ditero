import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, expect, test, vi } from "vitest";
import type { Fetcher } from "../cli/client.ts";
import { createDiteroMcp, mcpConfiguration } from "./server.ts";

const token = `ditero_pat_${"A".repeat(43)}`;
const env = { DITERO_URL: "https://todo.example.test", DITERO_TOKEN: token };
const key = "00000000-0000-4000-8000-000000000001";
const list = {
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
const create = { workspaceId: "workspace", title: "Original", kind: "tasks" };
const update = {
	workspaceId: "workspace",
	expectedState: "a".repeat(64),
	patch: { title: "Edited" },
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function protocol(fetcher: Fetcher) {
	const client = new Client(
		{ name: "list-tests", version: "1" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const handle = serveStdio(
		() => createDiteroMcp(mcpConfiguration(env), fetcher),
		{ transport: st },
	);
	cleanup.push(async () => {
		await client.close();
		await handle.close();
	});
	await client.connect(ct);
	return client;
}
test("list tools use fixed strict schemas and honest observation/mutation annotations", async () => {
	const client = await protocol(vi.fn());
	const tools = (await client.listTools()).tools;
	for (const name of ["create_list", "get_list_observation", "update_list"]) {
		const tool = tools.find((t) => t.name === name);
		expect(tool?.inputSchema.additionalProperties).toBe(false);
		expect(tool?.outputSchema?.additionalProperties).toBe(false);
		expect(tool?.annotations).toMatchObject({
			readOnlyHint: name === "get_list_observation",
			destructiveHint: name === "update_list",
			idempotentHint: true,
		});
	}
});
test("three list tools perform exactly one named HTTP operation and return matching structured/text envelopes", async () => {
	const requests: { path: string; method: unknown; body: unknown }[] = [];
	const client = await protocol(async (url, init) => {
		requests.push({ path: url.pathname, method: init.method, body: init.body });
		return Response.json(
			{
				version: 1,
				data:
					init.method === "GET"
						? { snapshot: list, stateToken: "a".repeat(64) }
						: {
								kind:
									init.method === "POST"
										? "list-create-ack"
										: "list-update-ack",
								snapshot: list,
							},
				nextCursor: null,
			},
			{ status: init.method === "POST" ? 201 : 200 },
		);
	});
	for (const [name, args] of [
		["create_list", { requestId: key, list: create }],
		["get_list_observation", { listId: "list" }],
		["update_list", { requestId: key, listId: "list", update }],
	] as const) {
		const result = await client.callTool({ name, arguments: args });
		expect(result.isError).not.toBe(true);
		expect(result.content).toEqual([
			{ type: "text", text: JSON.stringify(result.structuredContent) },
		]);
	}
	expect(requests.map((r) => [r.method, r.path])).toEqual([
		["POST", "/api/v1/lists"],
		["GET", "/api/v1/lists/list/observation"],
		["PATCH", "/api/v1/lists/list"],
	]);
	expect(JSON.parse(String(requests[2].body))).toEqual(update);
});
test.each([
	{ requestId: key, list: { ...create, ownerId: "other" } },
	{ requestId: key, list: { ...create, title: "x".repeat(501) } },
	{ requestId: key, list: { ...create, extra: "x".repeat(4096) } },
	{ requestId: key, list: { ...create, title: `${" ".repeat(4096)}Original` } },
	{ requestId: "wrong", list: create },
	{
		requestId: key,
		list: JSON.parse(
			'{"workspaceId":"workspace","title":"Original","kind":"tasks","__proto__":{}}',
		),
	},
])("invalid/oversized list arguments refuse before fetch %j", async (args) => {
	const fetcher = vi.fn();
	const client = await protocol(fetcher);
	let refused = false;
	try {
		refused =
			(await client.callTool({ name: "create_list", arguments: args }))
				.isError === true;
	} catch {
		refused = true;
	}
	expect(refused).toBe(true);
	expect(fetcher).not.toHaveBeenCalled();
});
test.each([
	401, 403, 409,
])("list API status %s is safe and never auto-observes/retries", async (status) => {
	const fetcher = vi.fn(async () => new Response(token, { status }));
	const client = await protocol(fetcher);
	const result = await client.callTool({
		name: "update_list",
		arguments: { listId: "list", requestId: key, update },
	});
	expect(result.isError).toBe(true);
	expect(result.structuredContent).toMatchObject({ error: { status } });
	expect(JSON.stringify(result)).not.toContain(token);
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test("mismatched response fails without partial output", async () => {
	const client = await protocol(async () =>
		Response.json({
			version: 1,
			data: { kind: "list-update-ack", snapshot: { ...list, id: "other" } },
			nextCursor: null,
		}),
	);
	const result = await client.callTool({
		name: "update_list",
		arguments: { listId: "list", requestId: key, update },
	});
	expect(result.isError).toBe(true);
	expect(result.structuredContent).toMatchObject({
		error: { code: "invalid_response" },
	});
});
test("real Bun MCP stdio preserves exact manual retry after lost response and refuses redirects/oversized payloads", async () => {
	const requests: {
		path: string;
		method: string;
		body: string;
		key: string;
	}[] = [];
	let mode = "lost";
	const api = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		requests.push({
			path: req.url ?? "",
			method: req.method ?? "",
			body,
			key: String(req.headers["idempotency-key"]),
		});
		if (mode === "lost") {
			res.destroy();
			return;
		}
		if (mode === "redirect") {
			res.writeHead(302, { location: "https://other.example.test" });
			res.end(token);
			return;
		}
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({
				version: 1,
				data: { kind: "list-create-ack", snapshot: list },
				nextCursor: null,
			}),
		);
	});
	await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
	const address = api.address();
	if (!address || typeof address === "string")
		throw new Error("Missing listener");
	cleanup.push(async () => {
		api.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			api.close((e) => (e ? reject(e) : resolve())),
		);
	});
	const transport = new StdioClientTransport({
		command: "bun",
		args: [
			"run",
			fileURLToPath(new URL("./index.ts", import.meta.url)),
			"--allow-loopback-http",
		],
		env: {
			DITERO_URL: `http://127.0.0.1:${address.port}`,
			DITERO_TOKEN: token,
		},
		stderr: "pipe",
	});
	let stderr = "";
	transport.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const client = new Client(
		{ name: "stdio-lists", version: "1" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	await client.connect(transport);
	cleanup.push(() => client.close());
	const args = { requestId: key, list: create };
	const lost = await client.callTool({ name: "create_list", arguments: args });
	expect(lost.isError).toBe(true);
	mode = "normal";
	const replay = await client.callTool({
		name: "create_list",
		arguments: args,
	});
	expect(replay.isError).not.toBe(true);
	expect(requests[0]).toEqual(requests[1]);
	mode = "redirect";
	expect(
		(await client.callTool({ name: "create_list", arguments: args })).isError,
	).toBe(true);
	expect(requests).toHaveLength(3);
	try {
		const refused = await client.callTool({
			name: "create_list",
			arguments: {
				requestId: key,
				list: { ...create, title: "x".repeat(4096) },
			},
		});
		expect(refused.isError).toBe(true);
	} catch (error) {
		expect(error).toBeInstanceOf(Error);
	}
	expect(requests).toHaveLength(3);
	expect(stderr).toBe("");
	expect(JSON.stringify([lost, replay])).not.toContain(token);
}, 15000);

test.each([
	["get_list_observation", "."],
	["get_list_observation", ".."],
	["update_list", "."],
	["update_list", ".."],
])("dot-segment list IDs fail before HTTP through MCP protocol %s %s", async (name, listId) => {
	const fetcher = vi.fn(async () =>
		Response.json({
			version: 1,
			data: { kind: "list-update-ack", snapshot: list },
			nextCursor: null,
		}),
	);
	const client = await protocol(fetcher);
	const result = await client.callTool({
		name,
		arguments: {
			listId,
			...(name === "update_list" ? { requestId: key, update } : {}),
		},
	});
	expect(result.isError).toBe(true);
	expect(result.structuredContent).toMatchObject({
		error: { code: "invalid_input" },
	});
	expect(fetcher).not.toHaveBeenCalled();
});
