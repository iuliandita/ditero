import { expect, test, vi } from "vitest";
import { parseArguments } from "../cli/arguments.ts";
import type { Fetcher } from "../cli/client.ts";
import { terminalApi } from "./api.ts";

const options = parseArguments(["profile"], {
	DITERO_URL: "https://example.test",
	DITERO_TOKEN: `ditero_pat_${"a".repeat(43)}`,
});
if (!options) throw new Error("Expected CLI options");
const key = "00000000-0000-4000-8000-000000000001";
const snapshot = {
	version: 1,
	taskId: "task",
	listId: "list",
	workspaceId: "workspace",
	title: "Milk",
	notes: null,
	dueAt: null,
	dueAllDay: false,
	priority: 0,
	createdAt: null,
	done: false,
	completedAt: null,
	listKind: "tasks",
	rrule: null,
	recurrenceRelative: false,
	recurrenceAnchorAt: null,
	recurrenceConsumed: null,
};
const observation = { snapshot, stateToken: "a".repeat(64) };
const children = { version: 1 as const, count: 0, token: "b".repeat(64) };
const task = {
	id: "task",
	listId: "list",
	workspaceId: "workspace",
	title: "Milk!",
	done: false,
	notes: null,
	dueAt: null,
	dueAllDay: false,
	priority: 0,
	completedAt: null,
	createdAt: null,
	sortKey: "a0",
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
const result = (data: unknown) =>
	Response.json({ version: 1, data, nextCursor: null });

test.each([
	false,
	true,
])("uses one explicit observation GET with strict guards (deletion %s)", async (deletion) => {
	const fetcher = vi.fn<Fetcher>(async () =>
		result(
			deletion ? { ...observation, childrenState: children } : observation,
		),
	);
	const api = terminalApi(options, fetcher);
	const observed = await (deletion
		? api.observeDeletion("task", new AbortController().signal)
		: api.observe("task", new AbortController().signal));
	expect(observed).toMatchObject(observation);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(fetcher.mock.calls[0][0].pathname).toBe(
		`/api/v1/tasks/task/${deletion ? "deletion-observation" : "observation"}`,
	);
	expect(fetcher.mock.calls[0][1].method).toBe("GET");
});

test("PATCH carries the exact observed token and normalized body without a hidden read", async () => {
	const fetcher = vi.fn<Fetcher>(async () => result(task));
	await terminalApi(options, fetcher).update(
		"task",
		{
			listId: "list",
			expectedState: observation.stateToken,
			patch: { title: " Milk! ", notes: "first\nsecond" },
		},
		key,
		new AbortController().signal,
	);
	expect(fetcher).toHaveBeenCalledTimes(1);
	const [url, init] = fetcher.mock.calls[0];
	expect(url.pathname).toBe("/api/v1/tasks/task");
	expect(init.method).toBe("PATCH");
	expect(new Headers(init.headers).get("idempotency-key")).toBe(key);
	expect(JSON.parse(String(init.body))).toEqual({
		listId: "list",
		expectedState: observation.stateToken,
		patch: { title: "Milk!", notes: "first\nsecond" },
	});
});

test("DELETE carries explicit cascade consent and accepts the original deletion acknowledgement", async () => {
	const fetcher = vi.fn<Fetcher>(async () =>
		result({
			taskId: "task",
			listId: "list",
			deleted: true,
			deletedChildren: 0,
		}),
	);
	const body = {
		listId: "list",
		expectedState: observation.stateToken,
		expectedChildrenState: children,
		cascadeChildren: false,
	};
	await terminalApi(options, fetcher).delete(
		"task",
		body,
		key,
		new AbortController().signal,
	);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(fetcher.mock.calls[0][1].method).toBe("DELETE");
	expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toEqual(body);
});

test.each([
	401, 403, 409, 410, 503,
])("write refusal %s never observes or retries", async (status) => {
	const fetcher = vi.fn<Fetcher>(async () => new Response(null, { status }));
	await expect(
		terminalApi(options, fetcher).update(
			"task",
			{
				listId: "list",
				expectedState: observation.stateToken,
				patch: { priority: 2 },
			},
			key,
			new AbortController().signal,
		),
	).rejects.toMatchObject({ status });
	expect(fetcher).toHaveBeenCalledTimes(1);
});

test("invalid observation, oversized update and cancelled request fail without another wire call", async () => {
	const fetcher = vi.fn<Fetcher>(async () =>
		result({ ...observation, stateToken: "bad" }),
	);
	const api = terminalApi(options, fetcher);
	await expect(
		api.observe("task", new AbortController().signal),
	).rejects.toMatchObject({ code: "invalid_response" });
	expect(fetcher).toHaveBeenCalledTimes(1);
	await expect(
		api.update(
			"task",
			{
				listId: "list",
				expectedState: observation.stateToken,
				patch: { notes: "😀".repeat(32768) },
			},
			key,
			new AbortController().signal,
		),
	).rejects.toMatchObject({ code: "invalid_input" });
	const abort = new AbortController();
	abort.abort();
	await expect(api.observe("task", abort.signal)).rejects.toMatchObject({
		code: "cancelled",
	});
	expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each([
	false,
	true,
])("rejects an observation for another task (deletion %s)", async (deletion) => {
	const fetcher = vi.fn<Fetcher>(async () =>
		result(
			deletion ? { ...observation, childrenState: children } : observation,
		),
	);
	const api = terminalApi(options, fetcher);
	await expect(
		deletion
			? api.observeDeletion("another", new AbortController().signal)
			: api.observe("another", new AbortController().signal),
	).rejects.toMatchObject({ code: "invalid_response" });
	expect(fetcher).toHaveBeenCalledTimes(1);
});
