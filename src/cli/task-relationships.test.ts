import { expect, test, vi } from "vitest";
import { parseArguments } from "./arguments.ts";
import { discover } from "./client.ts";
import { runCli } from "./index.ts";
import {
	encodeTaskRelationshipsInput,
	taskRelationshipsWorkflow,
} from "./task-relationships-workflow.ts";

const env = {
	DITERO_URL: "https://todo.example.test",
	DITERO_TOKEN: `ditero_pat_${"A".repeat(43)}`,
};
const key = "00000000-0000-4000-8000-000000000001";
const relationships = {
	workspaceId: "workspace",
	listId: "list",
	expectedState: "a".repeat(64),
	assigneeIds: ["z", "a"],
	labelIds: ["b", "a"],
};
const snapshot = {
	version: 1,
	taskId: "task",
	listId: "list",
	workspaceId: "workspace",
	assigneeIds: ["a", "z"],
	labelIds: ["a", "b"],
};
const ack = { kind: "task-relationships-update-ack", snapshot };
const envelope = (data: unknown) =>
	Response.json({ version: 1, data, nextCursor: null });
function options(command = "update-task-relationships", id = "task") {
	const value = parseArguments(
		[
			command,
			"--task",
			id,
			...(command === "update-task-relationships" ? ["--request-id", key] : []),
		],
		env,
	);
	if (!value) throw new Error("Missing options");
	return value;
}
async function run(raw: unknown, response: unknown = ack) {
	const fetcher = vi.fn(async () => envelope(response)),
		stdout = vi.fn(),
		stderr = vi.fn();
	const exit = await runCli(
		[
			"update-task-relationships",
			"--task",
			"task",
			"--request-id",
			key,
			"--json",
		],
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
test("relationship observation performs one encoded GET without stdin and preserves complete large sets", async () => {
	const reader = vi.fn();
	const complete = {
		...snapshot,
		taskId: "task/part",
		assigneeIds: Array.from({ length: 21 }, (_, i) => `person${i}`),
		labelIds: Array.from({ length: 51 }, (_, i) => `label${i}`),
	};
	const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
		expect(url.pathname).toBe("/api/v1/tasks/task%2Fpart/relationships");
		expect(url.search).toBe("");
		expect(init.method).toBe("GET");
		expect(init.headers).not.toHaveProperty("idempotency-key");
		return envelope({
			snapshot: complete,
			stateToken: relationships.expectedState,
		});
	});
	expect(
		await taskRelationshipsWorkflow(
			options("observe-task-relationships", "task/part"),
			fetcher,
			reader,
		),
	).toEqual({
		version: 1,
		data: { snapshot: complete, stateToken: relationships.expectedState },
		nextCursor: null,
	});
	expect(reader).not.toHaveBeenCalled();
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each([
	relationships,
	{ ...relationships, assigneeIds: [], labelIds: [] },
])("replacement sends one canonical complete PATCH, including explicit clearing", async (body) => {
	const canonical = {
		...body,
		assigneeIds: [...body.assigneeIds].sort(),
		labelIds: [...body.labelIds].sort(),
	};
	const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
		expect(url.pathname).toBe("/api/v1/tasks/task/relationships");
		expect(init).toMatchObject({
			method: "PATCH",
			headers: { "idempotency-key": key },
			redirect: "error",
		});
		expect(JSON.parse(String(init.body))).toEqual(canonical);
		return envelope({
			...ack,
			snapshot: {
				...snapshot,
				assigneeIds: canonical.assigneeIds,
				labelIds: canonical.labelIds,
			},
		});
	});
	await taskRelationshipsWorkflow(options(), fetcher, async () =>
		encodeTaskRelationshipsInput(body),
	);
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each([
	new Uint8Array([255]),
	new Uint8Array(65537),
	{ ...relationships, extra: true },
	{ ...relationships, assigneeIds: undefined },
	{ ...relationships, labelIds: undefined },
	{ ...relationships, assigneeIds: ["a", "a"] },
	{ ...relationships, labelIds: ["a", "a"] },
	{
		...relationships,
		assigneeIds: Array.from({ length: 21 }, (_, i) => String(i)),
	},
	{
		...relationships,
		labelIds: Array.from({ length: 51 }, (_, i) => String(i)),
	},
	{ ...relationships, workspaceId: "x".repeat(257) },
	{ ...relationships, labelIds: ["bad\u0000id"] },
])("invalid complete replacement fails before HTTP: %j", async (raw) => {
	const result = await run(raw);
	expect(result.exit).toBe(2);
	expect(result.fetcher).not.toHaveBeenCalled();
	expect(result.stdout).not.toHaveBeenCalled();
});
test.each([".", ".."])("dot segment %s refuses before HTTP", async (id) => {
	const fetcher = vi.fn();
	await expect(
		taskRelationshipsWorkflow(
			options("update-task-relationships", id),
			fetcher,
			async () => encodeTaskRelationshipsInput(relationships),
		),
	).rejects.toMatchObject({ code: "invalid_input" });
	expect(fetcher).not.toHaveBeenCalled();
});
test.each([
	{ ...ack, extra: true },
	{ ...ack, snapshot: { ...snapshot, taskId: "replacement" } },
	{ ...ack, snapshot: { ...snapshot, listId: "other" } },
	{ ...ack, snapshot: { ...snapshot, workspaceId: "other" } },
	{ ...ack, snapshot: { ...snapshot, assigneeIds: ["a"] } },
	{ ...ack, snapshot: { ...snapshot, labelIds: ["b", "a"] } },
	{ ...ack, snapshot: { ...snapshot, version: 2 } },
])("historical acknowledgement must match canonical requested scope and sets: %j", async (response) => {
	const result = await run(relationships, response);
	expect(result.exit).toBe(8);
	expect(result.stdout).not.toHaveBeenCalled();
});
test("invalid observation scope and extra fields fail closed", async () => {
	for (const data of [
		{
			snapshot: { ...snapshot, taskId: "other" },
			stateToken: relationships.expectedState,
		},
		{ snapshot, stateToken: relationships.expectedState, extra: true },
	]) {
		await expect(
			taskRelationshipsWorkflow(
				options("observe-task-relationships"),
				async () => envelope(data),
			),
		).rejects.toMatchObject({ code: "invalid_response" });
	}
});
test("array descriptors and known-field bounds precede serialization without invoking getters", () => {
	let invoked = false;
	const accessor = Object.defineProperty(["a"], "0", {
		enumerable: true,
		get() {
			invoked = true;
			return "a";
		},
	});
	const sparse = new Array(1);
	const extra = Object.assign(["a"], { extra: true });
	for (const assigneeIds of [accessor, sparse, extra])
		expect(() =>
			encodeTaskRelationshipsInput({ ...relationships, assigneeIds }),
		).toThrow();
	expect(invoked).toBe(false);
	expect(() =>
		encodeTaskRelationshipsInput({
			...relationships,
			expectedState: "x".repeat(100000),
		}),
	).toThrow();
	expect(
		JSON.parse(
			new TextDecoder().decode(encodeTaskRelationshipsInput(relationships)),
		),
	).toEqual({
		...relationships,
		assigneeIds: ["a", "z"],
		labelIds: ["a", "b"],
	});
});
test("uncertain outcome needs an exact manual retry without hidden observations", async () => {
	const calls: unknown[] = [];
	const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
		calls.push({ method: init.method, body: init.body, headers: init.headers });
		if (calls.length === 1) throw new Error("lost response");
		return envelope(ack);
	});
	await expect(
		taskRelationshipsWorkflow(options(), fetcher, async () =>
			encodeTaskRelationshipsInput(relationships),
		),
	).rejects.toMatchObject({ code: "network_error" });
	expect(calls).toHaveLength(1);
	await taskRelationshipsWorkflow(options(), fetcher, async () =>
		encodeTaskRelationshipsInput(relationships),
	);
	expect(calls[1]).toEqual(calls[0]);
});
test("cancellation reaches the HTTP signal without retry", async () => {
	const controller = new AbortController();
	const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
		expect(init.signal).toBeDefined();
		controller.abort();
		expect(init.signal?.aborted).toBe(true);
		throw new Error("aborted");
	});
	await expect(
		taskRelationshipsWorkflow(
			options(),
			fetcher,
			async () => encodeTaskRelationshipsInput(relationships),
			controller.signal,
		),
	).rejects.toMatchObject({ code: "cancelled" });
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test("stale relationship refusal remains an explicit conflict with no reads or retries", async () => {
	const fetcher = vi.fn(async () => new Response("conflict", { status: 409 }));
	await expect(
		taskRelationshipsWorkflow(options(), fetcher, async () =>
			encodeTaskRelationshipsInput(relationships),
		),
	).rejects.toMatchObject({ status: 409, exitCode: 10 });
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each([
	"observe-task-relationships",
	"update-task-relationships",
])("direct discovery refuses %s before HTTP", async (command) => {
	const fetcher = vi.fn();
	await expect(discover(options(command), fetcher)).rejects.toMatchObject({
		code: "invalid_arguments",
	});
	expect(fetcher).not.toHaveBeenCalled();
});
test("observation refuses a request UUID and replacement requires one", () => {
	expect(() =>
		parseArguments(
			["observe-task-relationships", "--task", "task", "--request-id", key],
			env,
		),
	).toThrow();
	expect(() =>
		parseArguments(["update-task-relationships", "--task", "task"], env),
	).toThrow();
});
