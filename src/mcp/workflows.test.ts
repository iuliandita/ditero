import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Fetcher } from "../cli/client.ts";
import { createDiteroMcp, mcpConfiguration } from "./server.ts";

const token = `ditero_pat_${"A".repeat(43)}`;
const requestId = "00000000-0000-4000-8000-000000000001";
const profile = {
	id: "me",
	name: "Me",
	timezone: "Europe/Berlin",
	timezoneChosen: true,
	locale: "en",
	serverTime: "2026-10-24T10:00:00Z",
	tokenAccess: "write",
};
const workspace = {
	id: "private",
	name: "Private",
	kind: "personal",
	ownerId: "me",
	role: "owner",
};
const list = {
	id: "inbox",
	workspaceId: "private",
	ownerId: "me",
	title: "Inbox",
	kind: "tasks",
	icon: null,
	folderId: null,
	sortKey: "a0",
	completedDisplay: "sink",
};
const person = {
	id: "alex",
	name: "Alex",
	image: null,
	workspaceIds: ["private"],
};
const task = {
	id: "saved",
	listId: "inbox",
	workspaceId: "private",
	title: "Authoritative coffee",
	done: false,
	notes: null,
	dueAt: null,
	dueAllDay: false,
	priority: 0,
	completedAt: null,
	createdAt: null,
	sortKey: "a1",
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
const intent = {
	title: "Buy coffee",
	target: { kind: "list", selector: { name: "Inbox" }, personal: true },
	due: { day: "tomorrow" },
	assignees: [{ name: "Alex" }],
};
const create = { requestId, task: { listId: "inbox", title: "Buy coffee" } };
const snapshot: Record<string, unknown> = {
	me: profile,
	workspaces: [workspace],
	lists: [list],
	people: [person],
	labels: [],
	views: [],
	dashboards: [],
};
const envelope = (
	data: unknown,
	nextCursor: string | null = null,
	status = 200,
) => Response.json({ version: 1, data, nextCursor }, { status });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function protocol(
	stdio: boolean,
	fetcher: Fetcher,
	transportError = false,
) {
	const client = new Client(
		{ name: "workflow-test", version: "1" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	if (!stdio) {
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		const handle = serveStdio(
			() =>
				createDiteroMcp(
					mcpConfiguration({
						DITERO_URL: "https://todo.example.test",
						DITERO_TOKEN: token,
					}),
					fetcher,
				),
			{ transport: serverTransport },
		);
		cleanup.push(async () => {
			await client.close();
			await handle.close();
		});
		await client.connect(clientTransport);
	} else {
		const api = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const result = await fetcher(
				new URL(request.url ?? "/", "http://127.0.0.1"),
				{
					method: request.method,
					headers: request.headers as Record<string, string>,
					body: Buffer.concat(chunks).toString() || undefined,
				},
			);
			response.writeHead(result.status, Object.fromEntries(result.headers));
			response.end(await result.text());
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
			throw new Error("Expected owned ephemeral port");
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
		cleanup.push(async () => {
			await client.close();
			if (transportError) {
				expect(stderr).toBe("Ditero MCP transport error.\n");
				expect(stderr).not.toContain(token);
			} else expect(stderr).toBe("");
		});
		await client.connect(transport);
	}
	return client;
}

for (const stdio of [false, true])
	describe(stdio ? "actual Bun stdio workflows" : "SDK workflows", () => {
		test("plans every page, personal destination, timezone and large notes without writes", async () => {
			const paths: string[] = [];
			const client = await protocol(stdio, async (url, init) => {
				expect(init.method).toBe("GET");
				paths.push(url.pathname);
				const resource = url.pathname.split("/").at(-1) ?? "";
				if (resource === "lists")
					return url.searchParams.has("cursor")
						? envelope([list])
						: envelope([], "next_lists");
				return envelope(snapshot[resource]);
			});
			const result = await client.callTool({
				name: "plan_task",
				arguments: { ...intent, notes: "n".repeat(20_000) },
			});
			expect(result.isError).not.toBe(true);
			expect(result.structuredContent).toMatchObject({
				version: 1,
				target: { kind: "list", id: "inbox" },
				timezone: "Europe/Berlin",
				resolvedAt: profile.serverTime,
				task: {
					listId: "inbox",
					dueAt: "2026-10-25T11:00:00.000Z",
					assigneeIds: ["alex"],
					notes: "n".repeat(20_000),
				},
			});
			expect(result.content).toEqual([
				{ type: "text", text: JSON.stringify(result.structuredContent) },
			]);
			expect(paths).toEqual([
				"/api/v1/me",
				"/api/v1/workspaces",
				"/api/v1/lists",
				"/api/v1/lists",
				"/api/v1/people",
				"/api/v1/labels",
				"/api/v1/views",
				"/api/v1/dashboards",
			]);
		});
		test("accepts the maximum 20 assignees and 50 labels through bounded SDK structure", async () => {
			const people = Array.from({ length: 20 }, (_, index) => ({
				...person,
				id: `person-${index}`,
				name: `Person ${index}`,
			}));
			const labels = Array.from({ length: 50 }, (_, index) => ({
				id: `label-${index}`,
				workspaceId: "private",
				name: `Label ${index}`,
				color: "blue",
			}));
			const client = await protocol(stdio, async (url, init) => {
				expect(init.method).toBe("GET");
				const resource = url.pathname.split("/").at(-1) ?? "";
				return envelope(
					resource === "people"
						? people
						: resource === "labels"
							? labels
							: snapshot[resource],
				);
			});
			const result = await client.callTool({
				name: "plan_task",
				arguments: {
					...intent,
					assignees: people.map(({ id }) => ({ id })),
					labels: labels.map(({ id }) => ({ id })),
				},
			});
			expect(result.isError).not.toBe(true);
			expect(result.structuredContent).toMatchObject({
				task: {
					assigneeIds: people.map(({ id }) => id).sort(),
					labelIds: labels.map(({ id }) => id).sort(),
				},
			});
		});

		test.each([
			200, 201,
		])("creates once with mandatory UUID and canonical body, authoritative HTTP %s result", async (status) => {
			const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
				expect(url.pathname).toBe("/api/v1/tasks");
				expect(init.method).toBe("POST");
				expect(new Headers(init.headers).get("authorization")).toBe(
					`Bearer ${token}`,
				);
				expect(new Headers(init.headers).get("idempotency-key")).toBe(
					requestId,
				);
				expect(JSON.parse(String(init.body))).toEqual({
					listId: "inbox",
					title: "Buy coffee",
					notes: null,
					dueAt: null,
					dueAllDay: false,
					priority: 0,
					assigneeIds: [],
					labelIds: ["a", "z"],
				});
				return envelope(task, null, status);
			});
			const client = await protocol(stdio, fetcher);
			const result = await client.callTool({
				name: "create_task",
				arguments: {
					...create,
					task: { ...create.task, labelIds: ["z", "a"] },
				},
			});
			expect(result.isError).not.toBe(true);
			expect(result.structuredContent).toEqual({
				version: 1,
				data: task,
				nextCursor: null,
			});
			expect(fetcher).toHaveBeenCalledTimes(1);
		});
		test.each([
			[409, "request_conflict"],
			[410, "task_deleted"],
			[403, "forbidden"],
			[401, "unauthorized"],
			[503, "http_error"],
		])("refusal %s never retries, replans, recreates or leaks response text", async (status, code) => {
			const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
				expect(init.method).toBe("POST");
				return new Response(`private ${token}`, { status: Number(status) });
			});
			const client = await protocol(stdio, fetcher);
			const result = await client.callTool({
				name: "create_task",
				arguments: create,
			});
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toMatchObject({
				error: { code, status },
			});
			expect(JSON.stringify(result)).not.toContain(token);
			expect(JSON.stringify(result)).not.toContain("private");
			expect(fetcher).toHaveBeenCalledTimes(1);
		});
		test.each([
			"ambiguous",
			"private",
			"read-token",
			"cycle",
		])("refuses incomplete or unauthorized planning: %s", async (failure) => {
			const client = await protocol(stdio, async (url, init) => {
				expect(init.method).toBe("GET");
				const resource = url.pathname.split("/").at(-1) ?? "";
				if (failure === "ambiguous" && resource === "people")
					return envelope([person, { ...person, id: "second" }]);
				if (failure === "private" && resource === "workspaces")
					return envelope([{ ...workspace, kind: "shared" }]);
				if (failure === "read-token" && resource === "me")
					return envelope({ ...profile, tokenAccess: "read" });
				if (failure === "cycle" && resource === "lists")
					return envelope([], "same");
				return envelope(snapshot[resource]);
			});
			const result = await client.callTool({
				name: "plan_task",
				arguments: intent,
			});
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toMatchObject({
				error: {
					code: {
						ambiguous: "ambiguous-assignee",
						private: "list-not-found",
						"read-token": "write-token-required",
						cycle: "invalid_response",
					}[failure],
				},
			});
			if (failure === "ambiguous")
				expect(result.structuredContent).toMatchObject({
					error: {
						choices: [
							{ id: "alex", name: "Alex" },
							{ id: "second", name: "Alex" },
						],
					},
				});
		});
		test.each([
			"__proto__",
			"constructor",
			"prototype",
		])("rejects raw nested prototype key %s before reads or writes", async (key) => {
			const fetcher = vi.fn(
				async () => new Response("Unexpected request", { status: 500 }),
			);
			const client = await protocol(stdio, fetcher);
			for (const [name, input] of [
				[
					"plan_task",
					{
						...intent,
						target: {
							...intent.target,
							selector: JSON.parse(`{"name":"Inbox","${key}":{}}`),
						},
					},
				],
				[
					"create_task",
					{
						...create,
						task: JSON.parse(`{"listId":"inbox","title":"x","${key}":{}}`),
					},
				],
			] as const) {
				try {
					const result = await client.callTool({ name, arguments: input });
					expect(result.isError).toBe(true);
					expect(JSON.stringify(result)).not.toContain(token);
				} catch (error) {
					expect(String(error)).toMatch(/invalid|validation|arguments/i);
					expect(String(error)).not.toContain(token);
				}
			}
			expect(fetcher).not.toHaveBeenCalled();
		});
		test("rejects excessive depth and byte size without echo or requests", async () => {
			const fetcher = vi.fn(
				async () => new Response("Unexpected request", { status: 500 }),
			);
			const client = await protocol(stdio, fetcher, stdio);
			const nested = JSON.parse(`${'{"x":'.repeat(34)}null${"}".repeat(34)}`);
			const depthRefusal = await client.callTool({
				name: "plan_task",
				arguments: { ...intent, nested },
			});
			expect(depthRefusal.isError).toBe(true);
			expect(JSON.stringify(depthRefusal)).not.toContain(token);
			// Valid character count, but UTF-8 JSON exceeds the independent byte budget.
			const oversized = { ...intent, notes: "é".repeat(32_768) };
			expect(
				new TextEncoder().encode(JSON.stringify(oversized)).byteLength,
			).toBeGreaterThan(65_536);
			if (stdio)
				await expect(
					client.callTool({ name: "plan_task", arguments: oversized }),
				).rejects.toThrow(/closed/i);
			else {
				const byteRefusal = await client.callTool({
					name: "plan_task",
					arguments: oversized,
				});
				expect(byteRefusal.isError).toBe(true);
				expect(JSON.stringify(byteRefusal)).not.toContain(token);
			}
			expect(fetcher).not.toHaveBeenCalled();
		});

		test.each([
			["create_task", { task: create.task }],
			["create_task", { ...create, requestId: "not-uuid" }],
			[
				"create_task",
				{
					...create,
					task: { ...create.task, server: "https://other.example.test" },
				},
			],
			[
				"create_task",
				{
					...create,
					task: { ...create.task, labelIds: ["duplicate", "duplicate"] },
				},
			],
			["create_task", { ...create, task: { ...create.task, dueAllDay: true } }],
			["plan_task", { ...intent, token }],
			[
				"plan_task",
				{ ...intent, target: { ...intent.target, shell: "echo private" } },
			],
			[
				"plan_task",
				JSON.parse(
					'{"title":"x","target":{"kind":"list","selector":{"name":"Inbox","__proto__":{}}}}',
				),
			],
			["plan_task", { ...intent, notes: "n".repeat(32_769) }],
			[
				"plan_task",
				{
					...intent,
					assignees: Array.from({ length: 257 }, () => ({ name: "Alex" })),
				},
			],
		])("invalid bounded input cannot issue any request: %s %j", async (name, args) => {
			const fetcher = vi.fn(
				async () => new Response("Unexpected request", { status: 500 }),
			);
			const client = await protocol(stdio, fetcher);
			try {
				const result = await client.callTool({ name, arguments: args });
				expect(result.isError).toBe(true);
				expect(JSON.stringify(result)).not.toContain(token);
			} catch (error) {
				expect(String(error)).toMatch(/invalid|validation|arguments/i);
				expect(String(error)).not.toContain(token);
			}
			expect(fetcher).not.toHaveBeenCalled();
		});
	});
