import { expect, test, vi } from "vitest";
import { encodeCommentCursor } from "../domain/public-api-comments.ts";
import { parseArguments } from "./arguments.ts";
import { commentWorkflow, encodeCommentInput } from "./comment-workflow.ts";
import { runCli } from "./index.ts";

const env = {
	DITERO_URL: "https://todo.example.test",
	DITERO_TOKEN: `ditero_pat_${"A".repeat(43)}`,
};
const key = "00000000-0000-4000-8000-000000000001";
const create = {
	workspaceId: "ws",
	listId: "list",
	expectedTaskState: "a".repeat(64),
	body: "  hello @Alex\n",
};
const update = {
	workspaceId: "ws",
	listId: "list",
	expectedState: "b".repeat(64),
	body: "  edited\n",
};
const deletion = {
	workspaceId: "ws",
	listId: "list",
	expectedState: "b".repeat(64),
	deleteScope: "comment-and-attachments",
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
	body: create.body,
};
const evidence = { sha256: "c".repeat(64), utf8Bytes: 900000 };
const envelope = (data: unknown, nextCursor: string | null = null) => ({
	version: 1,
	data,
	nextCursor,
});
const ack = (kind: string, body: unknown = snapshot.body) => ({
	kind,
	originalWorkspaceId: "ws",
	originalListId: "list",
	originalTaskId: "task",
	snapshot: { ...snapshot, body },
	...(kind === "comment-delete-ack" ? { deleted: true } : {}),
});
const bytes = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value));
async function cli(
	command: string,
	payload?: unknown,
	response: unknown = envelope([]),
	flags: string[] = [],
) {
	let stdout = "",
		stderr = "";
	const fetcher = vi.fn(async () => Response.json(response));
	const reader = vi.fn(async () => bytes(payload));
	const exit = await runCli(
		[command, "--task", "task", "--json", ...flags],
		env,
		{
			stdout: (text) => {
				stdout += text;
			},
			stderr: (text) => {
				stderr += text;
			},
		},
		fetcher,
		reader,
	);
	return { stdout, stderr, exit, fetcher, reader };
}
test.each([
	["add-comment", create, "POST", "comment-create-ack", create.body],
	["edit-comment", update, "PATCH", "comment-update-ack", update.body],
	["delete-comment", deletion, "DELETE", "comment-delete-ack", evidence],
])("%s preserves exact body/key and validates one immutable acknowledgment", async (command, payload, method, kind, body) => {
	const flags = [
		"--request-id",
		key,
		...(command === "add-comment" ? [] : ["--comment", "comment"]),
	];
	const result = await cli(
		command as string,
		payload,
		envelope(ack(kind as string, body)),
		flags,
	);
	expect(result.exit).toBe(0);
	expect(result.stderr).toBe("");
	expect(result.fetcher).toHaveBeenCalledTimes(1);
	const [url, init] = result.fetcher.mock.calls[0] as unknown as [
		URL,
		RequestInit,
	];
	expect(url.pathname).toBe(
		`/api/v1/tasks/task/comments${command === "add-comment" ? "" : "/comment"}`,
	);
	expect(init.method).toBe(method);
	expect(JSON.parse(String(init.body))).toEqual(payload);
	expect(init.headers).toMatchObject({ "idempotency-key": key });
	expect(JSON.parse(result.stdout)).toEqual(
		envelope(ack(kind as string, body)),
	);
});
test("read operations make no stdin reads and preserve compact imported observations", async () => {
	const page = await cli("list-task-comments", undefined, envelope([snapshot]));
	expect(page.exit).toBe(0);
	expect(page.reader).not.toHaveBeenCalled();
	const observed = await cli(
		"observe-comment",
		undefined,
		envelope({
			snapshot: {
				...snapshot,
				body: evidence,
				authorId: null,
				historicalAuthorKind: "source_claim",
				historicalAuthorName: "Original author",
				importedAt: snapshot.createdAt,
			},
			stateToken: "d".repeat(64),
		}),
		["--comment", "comment"],
	);
	expect(observed.exit).toBe(0);
	expect(observed.reader).not.toHaveBeenCalled();
});
test.each([
	["list-task-comments", []],
	["list-task-comments", ["--all"]],
	["list-task-comments", ["--workspace", "ws"]],
	["add-comment", ["--request-id", key, "--comment", "comment"]],
	["edit-comment", ["--request-id", key]],
	["observe-comment", ["--comment", "comment", "--request-id", key]],
	["delete-comment", ["--comment", "comment"]],
	["observe-comment", ["--comment", "\uD800"]],
])("invalid flags for %s make no HTTP requests %j", async (command, flags) => {
	const argv = [command, ...(flags.length ? ["--task", "task"] : []), ...flags];
	expect(() => parseArguments(argv, env)).toThrow();
});
test.each([
	".",
	"..",
	"a/../b",
	"\uD800",
	"\uDFFF",
	"task\0",
	"",
])("unsafe task ID %j is refused before I/O", async (taskId) => {
	const fetcher = vi.fn(),
		reader = vi.fn();
	const options = parseArguments(["profile"], env);
	if (!options) throw new Error("Missing options");
	await expect(
		commentWorkflow(
			{ ...options, command: "add-comment", taskId, requestId: key },
			fetcher,
			reader,
		),
	).rejects.toMatchObject({ code: "invalid_input" });
	expect(fetcher).not.toHaveBeenCalled();
	expect(reader).not.toHaveBeenCalled();
});
test.each([
	{ ...create, extra: true },
	{ ...create, body: "x".repeat(10001) },
	{ ...create, body: "\uD800" },
	{ ...create, expectedTaskState: "bad" },
	{ ...create, workspaceId: "../ws" },
	{ ...create, body: null },
])("strict create payload is rejected without wire %j", async (payload) => {
	const result = await cli(
		"add-comment",
		payload,
		envelope(ack("comment-create-ack")),
		["--request-id", key],
	);
	expect(result.exit).toBe(2);
	expect(result.fetcher).not.toHaveBeenCalled();
});
test("descriptor guards reject accessors, symbols and inherited payloads without invoking getters", () => {
	let invoked = false;
	const value = Object.defineProperty({ ...create }, "body", {
		enumerable: true,
		get() {
			invoked = true;
			throw new Error("getter");
		},
	});
	for (const payload of [
		value,
		Object.create(create),
		{ ...create, [Symbol("hidden")]: true },
	])
		expect(() => encodeCommentInput("create", payload)).toThrow();
	expect(invoked).toBe(false);
});
test("edit transport bound allows more than native creation character cap", async () => {
	const body = "x".repeat(20000),
		payload = { ...update, body };
	const result = await cli(
		"edit-comment",
		payload,
		envelope(ack("comment-update-ack", body)),
		["--comment", "comment", "--request-id", key],
	);
	expect(result.exit).toBe(0);
	expect(() =>
		encodeCommentInput("update", { ...update, body: "界".repeat(22000) }),
	).toThrow();
	expect(() =>
		encodeCommentInput("delete", { ...deletion, deleteScope: "comment" }),
	).toThrow();
});
test("fatal malformed UTF8 and missing UUID reject before HTTP; UUID rejects before stdin", async () => {
	const base = parseArguments(["profile"], env);
	if (!base) throw new Error("Missing options");
	const fetcher = vi.fn(),
		reader = vi.fn(async () => Uint8Array.of(0xc3, 0x28));
	await expect(
		commentWorkflow(
			{ ...base, command: "add-comment", taskId: "task" },
			fetcher,
			reader,
		),
	).rejects.toMatchObject({ code: "invalid_input" });
	expect(reader).not.toHaveBeenCalled();
	await expect(
		commentWorkflow(
			{ ...base, command: "add-comment", taskId: "task", requestId: key },
			fetcher,
			reader,
		),
	).rejects.toMatchObject({ code: "invalid_input" });
	expect(fetcher).not.toHaveBeenCalled();
});
test("task-bound cursor and page continuation validate before HTTP and before printing", async () => {
	const foreign = await cli("list-task-comments", undefined, envelope([]), [
		"--cursor",
		encodeCommentCursor("other", "before"),
	]);
	expect(foreign.exit).toBe(2);
	expect(foreign.fetcher).not.toHaveBeenCalled();
	const valid = await cli(
		"list-task-comments",
		undefined,
		envelope([snapshot], encodeCommentCursor("task", "comment")),
		["--limit", "1"],
	);
	expect(valid.exit).toBe(0);
	for (const [data, cursor] of [
		[[snapshot, snapshot], null],
		[[snapshot], encodeCommentCursor("other", "comment")],
		[[snapshot], encodeCommentCursor("task", "not-last")],
		[[{ ...snapshot, taskId: "other" }], null],
	] as const) {
		const result = await cli(
			"list-task-comments",
			undefined,
			envelope(data, cursor),
		);
		expect(result.exit).toBe(8);
		expect(result.stdout).toBe("");
	}
});
test.each([
	{ ...ack("comment-create-ack"), kind: "comment-update-ack" },
	ack("comment-create-ack", "trimmed"),
	{ ...ack("comment-create-ack"), originalListId: "other" },
	{ ...ack("comment-create-ack"), snapshot: { ...snapshot, taskId: "other" } },
	{
		...ack("comment-create-ack"),
		snapshot: { ...snapshot, sourceNamespaceId: "hidden" },
	},
])("mismatched response never prints acknowledgment %j", async (data) => {
	const result = await cli("add-comment", create, envelope(data), [
		"--request-id",
		key,
	]);
	expect(result.exit).toBe(8);
	expect(result.stdout).toBe("");
});
test("oversized response and declared size refuse without a partial page", async () => {
	const options = parseArguments(["list-task-comments", "--task", "task"], env);
	if (!options) throw new Error("Missing options");
	for (const response of [
		Response.json(envelope([{ ...snapshot, body: "x".repeat(262144) }])),
		new Response("{}", {
			headers: {
				"content-type": "application/json",
				"content-length": "262145",
			},
		}),
	]) {
		await expect(
			commentWorkflow(options, async () => response),
		).rejects.toMatchObject({ code: "invalid_response" });
	}
});
test("uncertain transport makes one request and exact deliberate retry keeps identity", async () => {
	const options = parseArguments(
		["add-comment", "--task", "task", "--request-id", key],
		env,
	);
	if (!options) throw new Error("Missing options");
	const calls: RequestInit[] = [];
	const fetcher = async (_url: URL, init: RequestInit) => {
		calls.push(init);
		if (calls.length === 1) throw new Error("lost");
		return Response.json(envelope(ack("comment-create-ack")));
	};
	await expect(
		commentWorkflow(options, fetcher, async () => bytes(create)),
	).rejects.toMatchObject({ code: "network_error" });
	expect(calls).toHaveLength(1);
	await commentWorkflow(options, fetcher, async () => bytes(create));
	expect(calls[1].body).toBe(calls[0].body);
	expect(calls[1].headers).toEqual(calls[0].headers);
});
test("pre-cancelled requests make no fetch and conflict advice preserves exact state", async () => {
	const options = parseArguments(
		["add-comment", "--task", "task", "--request-id", key],
		env,
	);
	if (!options) throw new Error("Missing options");
	const fetcher = vi.fn();
	await expect(
		commentWorkflow(
			options,
			fetcher,
			async () => bytes(create),
			AbortSignal.abort(),
		),
	).rejects.toMatchObject({ code: "cancelled" });
	expect(fetcher).not.toHaveBeenCalled();
	await expect(
		commentWorkflow(
			options,
			async () => new Response("private", { status: 409 }),
			async () => bytes(create),
		),
	).rejects.toMatchObject({
		code: "request_conflict",
		status: 409,
		message: expect.stringContaining("identical"),
	});
});
