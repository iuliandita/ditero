import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, expect, test, vi } from "vitest";
import release from "../../release.json";
import type { Fetcher } from "../cli/client.ts";
import { createDiteroMcp, mcpConfiguration } from "./server.ts";

const token = `ditero_pat_${"A".repeat(43)}`;
const env = { DITERO_URL: "https://todo.example.test", DITERO_TOKEN: token };
const profile = {
	id: "user",
	name: "Alex",
	timezone: "UTC",
	timezoneChosen: true,
	locale: "en",
	serverTime: "2026-10-03T12:00:00Z",
	tokenAccess: "read",
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function protocol(
	fetcher: Fetcher = async () =>
		Response.json({ version: 1, data: [], nextCursor: null }),
) {
	const client = new Client(
		{ name: "ditero-test", version: "1" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const handle = serveStdio(
		() => createDiteroMcp(mcpConfiguration(env), fetcher),
		{ transport: serverTransport },
	);
	cleanup.push(async () => {
		await client.close();
		await handle.close();
	});
	await client.connect(clientTransport);
	return client;
}

test("lists nine read tools and fixed workflow tools with strict bounded schemas and honest annotations", async () => {
	const client = await protocol();
	const { tools } = await client.listTools();
	expect(tools.map((tool) => tool.name)).toEqual([
		"get_profile",
		"list_workspaces",
		"list_lists",
		"list_tasks",
		"list_people",
		"list_labels",
		"list_views",
		"list_dashboards",
		"list_folders",
		"plan_task",
		"create_task",
		"complete_task",
		"get_task_observation",
		"get_task_deletion_observation",
		"update_task",
		"delete_task",
		"create_list",
		"get_list_observation",
		"update_list",
		"get_list_deletion_observation",
		"delete_list",
		"get_task_relationship_observation",
		"update_task_relationships",
		"get_task_placement_observation",
		"place_task",
		"list_task_comments",
		"get_comment_observation",
		"create_task_comment",
		"update_task_comment",
		"delete_task_comment",
		"list_webhooks",
		"create_webhook",
		"revoke_webhook",
	]);
	for (const tool of tools) {
		expect(tool.description).toBeTruthy();
		expect(tool.inputSchema.additionalProperties).toBe(false);
		expect(tool.annotations).toMatchObject({
			readOnlyHint: ![
				"create_task",
				"complete_task",
				"update_task",
				"delete_task",
				"create_list",
				"update_list",
				"delete_list",
				"update_task_relationships",
				"place_task",
				"create_task_comment",
				"update_task_comment",
				"delete_task_comment",
				"create_webhook",
				"revoke_webhook",
			].includes(tool.name),
			idempotentHint: tool.name !== "create_webhook",
			destructiveHint: [
				"complete_task",
				"update_task",
				"delete_task",
				"update_list",
				"delete_list",
				"update_task_relationships",
				"place_task",
				"update_task_comment",
				"delete_task_comment",
				"revoke_webhook",
			].includes(tool.name),
			openWorldHint: true,
		});
		expect(JSON.stringify(tool)).not.toContain(token);
	}
});

test("returns matching JSON text and structured API envelopes for all read tools", async () => {
	const urls: URL[] = [];
	const client = await protocol(async (url) => {
		urls.push(url);
		return Response.json({
			version: 1,
			data: url.pathname.endsWith("/me") ? profile : [],
			nextCursor: null,
		});
	});
	for (const tool of (await client.listTools()).tools.filter(
		(tool) => tool.name === "get_profile" || tool.name.startsWith("list_"),
	)) {
		const result = await client.callTool({
			name: tool.name,
			arguments: tool.name === "list_task_comments" ? { taskId: "task" } : {},
		});
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({
			version: 1,
			data: tool.name === "get_profile" ? profile : [],
			nextCursor: null,
		});
		expect(result.content).toEqual([
			{ type: "text", text: JSON.stringify(result.structuredContent) },
		]);
	}
	expect(urls.map((url) => url.origin)).toEqual(Array(11).fill(env.DITERO_URL));
});

test("passes task filters and opaque cursors without permitting authority changes", async () => {
	const fetcher = vi.fn(async (url: URL) => {
		expect(url.pathname).toBe("/api/v1/tasks");
		expect(url.searchParams.get("workspaceId")).toBe("../../;echo private");
		expect(url.searchParams.get("listId")).toBe(
			"https://other.example.test/path",
		);
		expect(url.searchParams.get("done")).toBe("false");
		expect(url.searchParams.get("limit")).toBe("2");
		expect(url.searchParams.get("cursor")).toBe("opaque_2");
		expect(url.origin).toBe(env.DITERO_URL);
		return Response.json({ version: 1, data: [], nextCursor: "opaque_3" });
	});
	const client = await protocol(fetcher);
	expect(
		(
			await client.callTool({
				name: "list_tasks",
				arguments: {
					workspaceId: "../../;echo private",
					listId: "https://other.example.test/path",
					done: false,
					limit: 2,
					cursor: "opaque_2",
				},
			})
		).structuredContent,
	).toEqual({ version: 1, data: [], nextCursor: "opaque_3" });
});

test.each([
	{ server: "https://other.example.test" },
	{ token },
	{ file: "/etc/passwd" },
	{ shell: "echo private" },
	{ all: true },
	{ limit: 101 },
	{ cursor: "../../" },
	{ workspaceId: "x".repeat(257) },
])("invalid tool input is rejected before any fetch %j", async (arguments_) => {
	const fetcher = vi.fn();
	const client = await protocol(fetcher);
	let failed = false;
	let printed = "";
	try {
		const result = await client.callTool({
			name: "list_tasks",
			arguments: arguments_,
		});
		failed = result.isError === true;
		printed = JSON.stringify(result);
	} catch (error) {
		failed = true;
		printed = error instanceof Error ? error.message : String(error);
	}
	expect(failed).toBe(true);
	expect(fetcher).not.toHaveBeenCalled();
	expect(printed).not.toContain(token);
});

test("profile rejects collection fields and unknown tools cannot make requests", async () => {
	const fetcher = vi.fn();
	const client = await protocol(fetcher);
	for (const params of [
		{ name: "get_profile", arguments: { workspaceId: "home" } },
		{ name: "run_shell", arguments: {} },
	]) {
		let failed = false;
		try {
			failed = (await client.callTool(params)).isError === true;
		} catch {
			failed = true;
		}
		expect(failed).toBe(true);
	}
	expect(fetcher).not.toHaveBeenCalled();
});

test("authentication and transport errors return safe stable data without credentials", async () => {
	for (const fetcher of [
		async () => new Response(token, { status: 401 }),
		async () => {
			throw new Error(`private ${token}`);
		},
	]) {
		const client = await protocol(fetcher);
		const result = await client.callTool({
			name: "get_profile",
			arguments: {},
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			version: 1,
			error: {
				code: expect.stringMatching(/unauthorized|network_error/),
				status: expect.toSatisfy(
					(value: unknown) => value === null || value === 401,
				),
			},
		});
		expect(JSON.stringify(result)).not.toContain(token);
	}
});

test("configuration is fixed at startup and rejects private or URL arguments safely", () => {
	const mutable = { ...env };
	const configuration = mcpConfiguration(mutable);
	mutable.DITERO_URL = "https://other.example.test";
	mutable.DITERO_TOKEN = "changed";
	expect(configuration.server).toBe(env.DITERO_URL);
	expect(configuration.token).toBe(token);
	expect(Object.isFrozen(configuration)).toBe(true);
	for (const argv of [
		["--server", "https://other.example.test"],
		["--token", token],
		[token],
	])
		expect(() => mcpConfiguration(env, argv)).toThrow(
			"Only --allow-loopback-http",
		);
	expect(() =>
		mcpConfiguration({ ...env, DITERO_URL: "http://127.0.0.1:3000" }),
	).toThrow();
	expect(
		mcpConfiguration({ ...env, DITERO_URL: "http://127.0.0.1:3000" }, [
			"--allow-loopback-http",
		]).server,
	).toBe("http://127.0.0.1:3000");
});

test("real Bun stdio speaks SDK protocol, rejects API redirects, and prints no private diagnostics", async () => {
	const paths: string[] = [];
	const api = createServer((request, response) => {
		paths.push(request.url ?? "");
		expect(request.headers.authorization).toBe(`Bearer ${token}`);
		if (request.url === "/api/v1/me") {
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({ version: 1, data: profile, nextCursor: null }),
			);
		} else if (request.url?.startsWith("/api/v1/labels")) {
			response.writeHead(302, {
				location: "https://other.example.test/private",
			});
			response.end(token);
		} else {
			response.writeHead(401);
			response.end(token);
		}
	});
	await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
	cleanup.push(
		() =>
			new Promise<void>((resolve, reject) =>
				api.close((error) => (error ? reject(error) : resolve())),
			),
	);
	const address = api.address();
	if (!address || typeof address === "string")
		throw new Error("Expected owned loopback port");
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
		{ name: "stdio-test", version: "1" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	const errors: Error[] = [];
	client.onerror = (error) => errors.push(error);
	await client.connect(transport);
	cleanup.push(() => client.close());
	expect((await client.listTools()).tools).toHaveLength(33);
	expect(
		(await client.callTool({ name: "get_profile", arguments: {} }))
			.structuredContent,
	).toEqual({ version: 1, data: profile, nextCursor: null });
	const rejected = await client.callTool({ name: "list_tasks", arguments: {} });
	expect(rejected.isError).toBe(true);
	expect(rejected.structuredContent).toMatchObject({ error: { status: 401 } });
	const redirected = await client.callTool({
		name: "list_labels",
		arguments: {},
	});
	expect(redirected.isError).toBe(true);
	expect(redirected.structuredContent).toMatchObject({
		error: { code: "network_error" },
	});
	expect(JSON.stringify([rejected, redirected])).not.toContain(token);
	expect(paths).toHaveLength(3);
	expect(errors).toEqual([]);
	expect(stderr).toBe("");
}, 15_000);

test("advertises the application release version in the real SDK handshake", async () => {
	const client = await protocol();
	expect(client.getServerVersion()).toMatchObject({
		name: "ditero",
		version: release.version,
	});
});
