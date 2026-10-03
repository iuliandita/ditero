import { expect, test, vi } from "vitest";
import { parseArguments } from "./arguments.ts";
import { runCli } from "./index.ts";
import { taskWorkflow } from "./task-workflow.ts";

const env = {
	DITERO_URL: "https://todo.example.test",
	DITERO_TOKEN: `ditero_pat_${"A".repeat(43)}`,
};
const key = "00000000-0000-4000-8000-000000000001";
const completion = {
	listId: "list",
	expectedDueAt: "2026-10-04T12:00:00.000Z",
};
const task = {
	id: "observed/task",
	listId: "list",
	workspaceId: "home",
	title: "Task",
	done: false,
	notes: null,
	dueAt: "2026-10-05T12:00:00.000Z",
	dueAllDay: false,
	priority: 0,
	completedAt: null,
	createdAt: null,
	sortKey: "a0",
	parentId: null,
	quantity: null,
	unit: null,
	category: null,
	rrule: "FREQ=DAILY",
	recurrenceRelative: false,
	reminderTime: null,
	assigneeIds: [],
	labelIds: [],
};
const argv = [
	"complete-task",
	"--task",
	task.id,
	"--request-id",
	key,
	"--json",
];
async function run(
	raw: unknown,
	fetcher: Parameters<typeof runCli>[3],
	args = argv,
) {
	const stdout = vi.fn();
	const stderr = vi.fn();
	const exit = await runCli(args, env, { stdout, stderr }, fetcher, async () =>
		raw instanceof Uint8Array
			? raw
			: new TextEncoder().encode(JSON.stringify(raw)),
	);
	return { exit, stdout, stderr };
}

test("completion posts only the inspected observation with its explicit retry UUID", async () => {
	const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
		expect(url.href).toBe(
			"https://todo.example.test/api/v1/tasks/observed%2Ftask/complete",
		);
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body))).toEqual(completion);
		expect(new Headers(init.headers).get("idempotency-key")).toBe(key);
		return Response.json({ version: 1, data: task, nextCursor: null });
	});
	const result = await run(completion, fetcher);
	expect(result.exit).toBe(0);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(JSON.parse(result.stdout.mock.calls[0][0])).toEqual({
		version: 1,
		data: task,
		nextCursor: null,
	});
});
test.each([
	["complete-task"],
	["complete-task", "--task", "task"],
	["complete-task", "--request-id", key],
	[...argv, "--all"],
	[...argv, "--limit", "1"],
	[...argv, "--cursor", "next"],
	[...argv, "--list", "list"],
	[...argv, "--workspace", "home"],
	[...argv, "--done", "false"],
	[...argv, "--task", "other"],
	["complete-task", "--task", "x".repeat(257), "--request-id", key],
	["complete-task", "--task", "task", "--request-id", "invalid"],
	["create-task", "--task", "task", "--request-id", key],
	["plan-task", "--task", "task"],
	["tasks", "--task", "task"],
])("completion rejects unsupported flags before network: %j", async (...args: string[]) => {
	const fetcher = vi.fn();
	const result = await run(completion, fetcher, args);
	expect(result.exit).toBe(2);
	expect(fetcher).not.toHaveBeenCalled();
});
test.each([
	{},
	{ listId: "list" },
	{ ...completion, expectedDueAt: "tomorrow" },
	{ ...completion, expectedDueAt: 4 },
	{ ...completion, done: true },
	new Uint8Array([255]),
	new Uint8Array(65537),
	new TextEncoder().encode(
		'{"listId":"list","expectedDueAt":null,"__proto__":{}}',
	),
])("completion rejects malformed or unsafe input before network", async (raw) => {
	const fetcher = vi.fn();
	const result = await run(raw, fetcher);
	expect(result.exit).toBe(2);
	expect(fetcher).not.toHaveBeenCalled();
	expect(result.stdout).not.toHaveBeenCalled();
});
test.each([
	[401, 3, "unauthorized"],
	[403, 4, "forbidden"],
	[404, 5, "not_found"],
	[409, 10, "request_conflict"],
	[410, 11, "task_deleted"],
])("completion refuses status %s without reads or automatic retries", async (status, exit, code) => {
	const fetcher = vi.fn(
		async () => new Response(env.DITERO_TOKEN, { status: Number(status) }),
	);
	const result = await run(completion, fetcher);
	expect(result.exit).toBe(exit);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(JSON.parse(result.stderr.mock.calls[0][0]).error).toMatchObject({
		code,
		status,
	});
	expect(result.stderr.mock.calls[0][0]).not.toContain(env.DITERO_TOKEN);
});
test("completion keeps a network failure uncertain and refuses invalid task DTOs", async () => {
	for (const fetcher of [
		vi.fn(async () => {
			throw new Error(env.DITERO_TOKEN);
		}),
		vi.fn(async () =>
			Response.json({
				version: 1,
				data: { ...task, secret: "private" },
				nextCursor: null,
			}),
		),
	]) {
		const result = await run(completion, fetcher);
		expect([7, 8]).toContain(result.exit);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(result.stdout).not.toHaveBeenCalled();
		expect(result.stderr.mock.calls[0][0]).not.toContain(env.DITERO_TOKEN);
	}
});
test("completion preserves caller cancellation before its sole POST", async () => {
	const options = parseArguments(argv, env);
	if (!options) throw new Error("Expected completion options");
	const controller = new AbortController();
	controller.abort();
	const fetcher = vi.fn();
	await expect(
		taskWorkflow(
			options,
			fetcher,
			async () => new TextEncoder().encode(JSON.stringify(completion)),
			controller.signal,
		),
	).rejects.toMatchObject({ code: "cancelled" });
	expect(fetcher).not.toHaveBeenCalled();
});
