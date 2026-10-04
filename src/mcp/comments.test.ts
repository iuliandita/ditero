import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
	McpServer,
	type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, expect, test, vi } from "vitest";
import type { Fetcher } from "../cli/client.ts";
import { encodeCommentCursor } from "../domain/public-api-comments.ts";
import { createDiteroMcp, mcpConfiguration } from "./server.ts";

const env = {
	DITERO_URL: "https://todo.example.test",
	DITERO_TOKEN: `ditero_pat_${"A".repeat(43)}`,
};
const key = "00000000-0000-4000-8000-000000000001";
const comment = {
	workspaceId: "ws",
	listId: "list",
	expectedTaskState: "a".repeat(64),
	body: "  hi @Alex\n",
};
const snapshot = {
	version: 1,
	commentId: "comment",
	taskId: "task",
	workspaceId: "ws",
	listId: "list",
	authorId: "author",
	createdAt: "2026-10-04T12:00:00Z",
	editedAt: null,
	historicalAuthorKind: null,
	historicalAuthorName: null,
	importedAt: null,
	provenanceRedactedAt: null,
	body: comment.body,
};
const compact = {
	...snapshot,
	body: { sha256: "c".repeat(64), utf8Bytes: 999999 },
};
const ack = {
	kind: "comment-create-ack",
	originalWorkspaceId: "ws",
	originalListId: "list",
	originalTaskId: "task",
	snapshot,
};
const args = { taskId: "task", requestId: key, comment };
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
test("five actual SDK tools perform one matching HTTP operation each", async () => {
	const paths: string[] = [],
		methods: string[] = [];
	const client = await protocol(async (url, init) => {
		paths.push(url.pathname);
		methods.push(init.method ?? "GET");
		const data = url.pathname.endsWith("observation")
			? { snapshot: compact, stateToken: "d".repeat(64) }
			: init.method === "GET"
				? [snapshot]
				: init.method === "DELETE"
					? {
							...ack,
							kind: "comment-delete-ack",
							snapshot: compact,
							deleted: true,
						}
					: init.method === "PATCH"
						? { ...ack, kind: "comment-update-ack" }
						: ack;
		return Response.json({ version: 1, data, nextCursor: null });
	});
	const update = {
		workspaceId: "ws",
		listId: "list",
		expectedState: "b".repeat(64),
		body: comment.body,
	};
	for (const [name, arguments_] of [
		["list_task_comments", { taskId: "task", limit: 1 }],
		["get_comment_observation", { taskId: "task", commentId: "comment" }],
		["create_task_comment", args],
		["update_task_comment", { ...args, commentId: "comment", comment: update }],
		[
			"delete_task_comment",
			{
				...args,
				commentId: "comment",
				comment: {
					workspaceId: "ws",
					listId: "list",
					expectedState: "b".repeat(64),
					deleteScope: "comment-and-attachments",
				},
			},
		],
	] as const) {
		const result = await client.callTool({ name, arguments: arguments_ });
		expect(result.isError).not.toBe(true);
		expect(result.content).toEqual([
			{ type: "text", text: JSON.stringify(result.structuredContent) },
		]);
	}
	expect(methods).toEqual(["GET", "GET", "POST", "PATCH", "DELETE"]);
	expect(paths).toEqual([
		"/api/v1/tasks/task/comments",
		"/api/v1/tasks/task/comments/comment/observation",
		"/api/v1/tasks/task/comments",
		"/api/v1/tasks/task/comments/comment",
		"/api/v1/tasks/task/comments/comment",
	]);
});
test.each([
	[
		"list_task_comments",
		{ taskId: "task", cursor: encodeCommentCursor("other", "comment") },
	],
	["list_task_comments", { taskId: "task", all: true }],
	["get_comment_observation", { taskId: "task", commentId: ".." }],
	["create_task_comment", { ...args, taskId: "\uD800" }],
	["create_task_comment", { ...args, requestId: "bad" }],
	[
		"create_task_comment",
		{ ...args, comment: { ...comment, body: "x".repeat(10001) } },
	],
	[
		"delete_task_comment",
		{
			...args,
			commentId: "comment",
			comment: {
				workspaceId: "ws",
				listId: "list",
				expectedState: "b".repeat(64),
				deleteScope: "comment",
			},
		},
	],
])("%s invalid arguments refuse without wire", async (name, arguments_) => {
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
test("registered schema refuses nested and outer descriptors before getters", async () => {
	const spy = vi.spyOn(McpServer.prototype, "registerTool");
	let schema: StandardSchemaWithJSON<unknown, unknown> | undefined;
	try {
		createDiteroMcp(mcpConfiguration(env), vi.fn());
		schema = spy.mock.calls.find(
			(call) => call[0] === "create_task_comment",
		)?.[1].inputSchema as unknown as StandardSchemaWithJSON<unknown, unknown>;
	} finally {
		spy.mockRestore();
	}
	if (!schema) throw new Error("Missing tool schema");
	let invoked = false;
	const getter = () => {
		invoked = true;
		throw new Error("getter");
	};
	for (const value of [
		Object.defineProperty({ ...args }, "comment", {
			enumerable: true,
			get: getter,
		}),
		{
			...args,
			comment: Object.defineProperty({ ...comment }, "body", {
				enumerable: true,
				get: getter,
			}),
		},
		Object.create(args),
		{ ...args, [Symbol("hidden")]: true },
	])
		expect((await schema["~standard"].validate(value)).issues).toBeDefined();
	expect(invoked).toBe(false);
	expect((await schema["~standard"].validate(args)).issues).toBeUndefined();
});
test("uncertain SDK outcome requires deliberate exact same-key retry", async () => {
	const calls: { body: unknown; headers: unknown }[] = [];
	const client = await protocol(async (_url, init) => {
		calls.push({ body: init.body, headers: init.headers });
		if (calls.length === 1) throw new Error("lost");
		return Response.json({ version: 1, data: ack, nextCursor: null });
	});
	expect(
		(await client.callTool({ name: "create_task_comment", arguments: args }))
			.isError,
	).toBe(true);
	expect(calls).toHaveLength(1);
	expect(
		(await client.callTool({ name: "create_task_comment", arguments: args }))
			.isError,
	).not.toBe(true);
	expect(calls[1]).toEqual(calls[0]);
});
test("SDK cancellation reaches active HTTP without a second request", async () => {
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
						reject(new Error("cancelled"));
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
			{ name: "create_task_comment", arguments: args },
			{ signal: controller.signal },
		)
		.catch((error) => error);
	await started;
	controller.abort();
	await aborted;
	await pending;
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each([
	401, 403, 404, 409, 429, 503,
])("HTTP%s yields one sanitized SDK refusal", async (status) => {
	const fetcher = vi.fn(async () => new Response(env.DITERO_TOKEN, { status })),
		client = await protocol(fetcher);
	const result = await client.callTool({
		name: "create_task_comment",
		arguments: args,
	});
	expect(result.isError).toBe(true);
	expect(JSON.stringify(result)).not.toContain(env.DITERO_TOKEN);
	expect(fetcher).toHaveBeenCalledTimes(1);
});
