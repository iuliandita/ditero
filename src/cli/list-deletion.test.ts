import { expect, test, vi } from "vitest";
import { parseArguments } from "./arguments.ts";
import { discover } from "./client.ts";
import { runCli } from "./index.ts";
import { encodeListDeletionInput, listWorkflow } from "./list-workflow.ts";

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
const ack = { kind: "list-delete-ack", snapshot, deletedTasks: 2 };
const observation = {
	snapshot,
	stateToken: deletion.expectedState,
	tasksState: deletion.expectedTasksState,
};
const envelope = (data: unknown) =>
	Response.json({ version: 1, data, nextCursor: null });
function options(command = "delete-list", id = "list") {
	const value = parseArguments(
		[
			command,
			"--list",
			id,
			...(command === "delete-list" ? ["--request-id", key] : []),
		],
		env,
	);
	if (!value) throw new Error("Missing options");
	return value;
}
async function run(raw: unknown, response = ack) {
	const fetcher = vi.fn(async () => envelope(response));
	const stdout = vi.fn(),
		stderr = vi.fn();
	const exit = await runCli(
		["delete-list", "--list", "list", "--request-id", key, "--json"],
		env,
		{ stdout, stderr },
		fetcher,
		async () =>
			raw instanceof Uint8Array
				? raw
				: new TextEncoder().encode(JSON.stringify(raw)),
	);
	return { exit, fetcher, stdout, stderr };
}
test("observe deletion performs one encoded GET without stdin or request key", async () => {
	const reader = vi.fn();
	const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
		expect(url.pathname).toBe("/api/v1/lists/list%2Fpart/deletion-observation");
		expect(init.method).toBe("GET");
		expect(init.headers).not.toHaveProperty("idempotency-key");
		return envelope({
			...observation,
			snapshot: { ...snapshot, id: "list/part" },
		});
	});
	await listWorkflow(
		options("observe-list-deletion", "list/part"),
		fetcher,
		reader,
	);
	expect(reader).not.toHaveBeenCalled();
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test("delete sends one explicit bounded DELETE and returns the immutable snapshot", async () => {
	const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
		expect(url.pathname).toBe("/api/v1/lists/list");
		expect(init).toMatchObject({
			method: "DELETE",
			headers: { "idempotency-key": key },
			redirect: "error",
		});
		expect(JSON.parse(String(init.body))).toEqual(deletion);
		return envelope(ack);
	});
	expect(
		await listWorkflow(options(), fetcher, async () =>
			encodeListDeletionInput(deletion),
		),
	).toEqual({ version: 1, data: ack, nextCursor: null });
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each([
	new Uint8Array([255]),
	new Uint8Array(4097),
	{ ...deletion, extra: true },
	{ ...deletion, cascadeTasks: undefined },
	{
		...deletion,
		expectedTasksState: { ...deletion.expectedTasksState, count: -1 },
	},
	{ ...deletion, workspaceId: "x".repeat(257) },
])("invalid deletion stdin fails before HTTP: %j", async (raw) => {
	const result = await run(raw);
	expect(result.exit).toBe(2);
	expect(result.fetcher).not.toHaveBeenCalled();
	expect(result.stdout).not.toHaveBeenCalled();
});
test.each([".", ".."])("dot segment %s fails before HTTP", async (id) => {
	const fetcher = vi.fn();
	await expect(
		listWorkflow(options("delete-list", id), fetcher, async () =>
			encodeListDeletionInput(deletion),
		),
	).rejects.toMatchObject({ code: "invalid_input" });
	expect(fetcher).not.toHaveBeenCalled();
});
test.each([
	{ ...ack, deletedTasks: 1 },
	{ ...ack, snapshot: { ...snapshot, id: "other" } },
	{ ...ack, snapshot: { ...snapshot, workspaceId: "other" } },
	{ ...ack, extra: true },
])("mismatched historical acknowledgement fails closed: %j", async (response) => {
	const result = await run(deletion, response);
	expect(result.exit).toBe(8);
	expect(result.stdout).not.toHaveBeenCalled();
});
test("descriptor and known-field bounds precede serialization", () => {
	let invoked = false;
	const raw = Object.defineProperty({ ...deletion }, "workspaceId", {
		enumerable: true,
		get() {
			invoked = true;
			return "workspace";
		},
	});
	expect(() => encodeListDeletionInput(raw)).toThrow();
	expect(invoked).toBe(false);
	expect(() =>
		encodeListDeletionInput({ ...deletion, expectedState: "x".repeat(100000) }),
	).toThrow();
});
test("lost response requires an explicit identical retry without observation", async () => {
	const calls: unknown[] = [];
	const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
		calls.push({ method: init.method, body: init.body, headers: init.headers });
		if (calls.length === 1) throw new Error("connection lost");
		return envelope(ack);
	});
	await expect(
		listWorkflow(options(), fetcher, async () =>
			encodeListDeletionInput(deletion),
		),
	).rejects.toMatchObject({ code: "network_error" });
	expect(fetcher).toHaveBeenCalledTimes(1);
	await listWorkflow(options(), fetcher, async () =>
		encodeListDeletionInput(deletion),
	);
	expect(calls[1]).toEqual(calls[0]);
});
test("cancellation reaches HTTP and never initiates a retry", async () => {
	const controller = new AbortController();
	const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
		const signal = init.signal;
		expect(signal).toBeDefined();
		controller.abort();
		expect(signal?.aborted).toBe(true);
		throw new Error("aborted");
	});
	await expect(
		listWorkflow(
			options(),
			fetcher,
			async () => encodeListDeletionInput(deletion),
			controller.signal,
		),
	).rejects.toMatchObject({ code: "cancelled" });
	expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each([
	"delete-list",
	"observe-list-deletion",
])("direct discovery refuses workflow %s before HTTP", async (command) => {
	const fetcher = vi.fn();
	await expect(discover(options(command), fetcher)).rejects.toMatchObject({
		code: "invalid_arguments",
	});
	expect(fetcher).not.toHaveBeenCalled();
});
