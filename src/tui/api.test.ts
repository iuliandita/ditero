import { expect, test, vi } from "vitest";
import { parseArguments } from "../cli/arguments.ts";
import {
	discover,
	type Fetcher,
	MAX_PAGES,
	MAX_TOTAL_BYTES,
} from "../cli/client.ts";
import { encodeCommentCursor } from "../domain/public-api-comments.ts";
import { terminalApi } from "./api.ts";
import {
	MAX_ORDER_ROWS,
	ORDER_PAGE_LIMIT,
	planOrdering,
	proposeOrdering,
} from "./ordering.ts";

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

const comment = (commentId: string, taskId = "task") => ({
	version: 1,
	commentId,
	taskId,
	workspaceId: "workspace",
	listId: "list",
	authorId: null,
	createdAt: "2026-10-03T12:00:00.000Z",
	editedAt: null,
	historicalAuthorKind: "source_claim",
	historicalAuthorName: "Imported Name",
	importedAt: "2026-10-04T12:00:00.000Z",
	provenanceRedactedAt: null,
	body: "line one\nline two",
});

test("comments use one bounded GET page bound to the task and cursor", async () => {
	const fetcher = vi.fn<Fetcher>(async () =>
		Response.json({
			version: 1,
			data: [comment("a"), comment("b")],
			nextCursor: encodeCommentCursor("task", "b"),
		}),
	);
	const page = await terminalApi(options, fetcher).comments(
		"task",
		encodeCommentCursor("task", "0"),
		new AbortController().signal,
	);
	expect(page.comments.map((item) => item.commentId)).toEqual(["a", "b"]);
	expect(page.nextCursor).toBe(encodeCommentCursor("task", "b"));
	expect(fetcher).toHaveBeenCalledTimes(1);
	const [url, init] = fetcher.mock.calls[0];
	expect(url.pathname).toBe("/api/v1/tasks/task/comments");
	expect(url.searchParams.get("limit")).toBe("50");
	expect(url.searchParams.get("cursor")).toBe(encodeCommentCursor("task", "0"));
	expect(url.searchParams.has("all")).toBe(false);
	expect(init.method ?? "GET").toBe("GET");
	expect(init.body).toBeUndefined();
});

test("comments reject another task's rows and unordered pages", async () => {
	for (const data of [[comment("a", "other")], [comment("b"), comment("a")]]) {
		const fetcher = vi.fn<Fetcher>(async () =>
			Response.json({ version: 1, data, nextCursor: null }),
		);
		await expect(
			terminalApi(options, fetcher).comments(
				"task",
				undefined,
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: "invalid_response" });
	}
});

test("comments reject provenance the database cannot store before any display", async () => {
	const redacted = "2026-10-05T12:00:00.000Z";
	for (const extra of [
		{ historicalAuthorKind: "unknown", historicalAuthorName: "Hidden" },
		{
			historicalAuthorKind: "unknown",
			historicalAuthorName: "Hidden",
			provenanceRedactedAt: redacted,
		},
		{ provenanceRedactedAt: redacted },
		{
			historicalAuthorKind: null,
			historicalAuthorName: null,
			provenanceRedactedAt: redacted,
		},
	]) {
		const fetcher = vi.fn<Fetcher>(async () =>
			Response.json({
				version: 1,
				data: [{ ...comment("a"), ...extra }],
				nextCursor: null,
			}),
		);
		await expect(
			terminalApi(options, fetcher).comments(
				"task",
				undefined,
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: "invalid_response" });
		expect(fetcher).toHaveBeenCalledTimes(1);
	}
});

test("comments keep valid unknown and redacted provenance as received", async () => {
	const redacted = {
		...comment("a"),
		historicalAuthorKind: "unknown",
		historicalAuthorName: null,
		provenanceRedactedAt: "2026-10-05T12:00:00.000Z",
	};
	const fetcher = vi.fn<Fetcher>(async () =>
		Response.json({ version: 1, data: [redacted], nextCursor: null }),
	);
	const page = await terminalApi(options, fetcher).comments(
		"task",
		undefined,
		new AbortController().signal,
	);
	expect(page.comments).toEqual([redacted]);
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

const orderList = "11111111-1111-4111-8111-111111111111";
const completedAt = "2026-10-04T12:00:00.000Z";
const orderTask = (id: string, extra: Record<string, unknown> = {}) => ({
	...task,
	id,
	listId: orderList,
	title: `Task ${id}`,
	sortKey: "a0",
	...extra,
});
const doneTask = (id: string) => orderTask(id, { done: true, completedAt });
const rowPage = (data: unknown[], nextCursor: string | null) =>
	Response.json({ version: 1, data, nextCursor });
const oversized = () =>
	new Response(" ".repeat(2 * 1024 * 1024 + 1), {
		headers: { "content-type": "application/json" },
	});
const rowId = (index: number) => `row-${String(index).padStart(3, "0")}`;
const readOrder = (fetcher: Fetcher, signal = new AbortController().signal) =>
	terminalApi(options, fetcher).orderRows(orderList, signal);

test("order rows read every page of the exact list, done rows included, with no done filter", async () => {
	const first = Array.from({ length: 100 }, (_, index) =>
		index % 2 ? doneTask(rowId(index)) : orderTask(rowId(index)),
	);
	const second = Array.from({ length: 20 }, (_, index) =>
		doneTask(rowId(100 + index)),
	);
	const fetcher = vi.fn<Fetcher>(async (url) =>
		url.searchParams.get("cursor") === "next_page"
			? rowPage(second, null)
			: rowPage(first, "next_page"),
	);
	const rows = await readOrder(fetcher);
	expect(rows.map((row) => row.id)).toEqual(
		[...first, ...second].map((row) => row.id),
	);
	expect(rows).toHaveLength(120);
	expect(rows.filter((row) => row.done)).toHaveLength(70);
	expect(fetcher).toHaveBeenCalledTimes(2);
	for (const [url, init] of fetcher.mock.calls) {
		expect(url.pathname).toBe("/api/v1/tasks");
		expect(url.searchParams.get("limit")).toBe(String(ORDER_PAGE_LIMIT));
		expect(url.searchParams.get("listId")).toBe(orderList);
		expect(url.searchParams.has("done")).toBe(false);
		expect(url.searchParams.has("workspaceId")).toBe(false);
		expect(init.method).toBe("GET");
		expect(init.body).toBeUndefined();
	}
	expect(fetcher.mock.calls[0][0].searchParams.has("cursor")).toBe(false);
	expect(fetcher.mock.calls[1][0].searchParams.get("cursor")).toBe("next_page");
	expect(MAX_ORDER_ROWS).toBe(MAX_PAGES * ORDER_PAGE_LIMIT);
});

test("order rows refuse a repeated cursor after the second page", async () => {
	const fetcher = vi.fn<Fetcher>(async () => rowPage([], "loop"));
	await expect(readOrder(fetcher)).rejects.toMatchObject({
		code: "invalid_response",
	});
	expect(fetcher).toHaveBeenCalledTimes(2);
});

test("order rows stop at the shared page bound instead of returning a partial list", async () => {
	let issued = 0;
	const fetcher = vi.fn<Fetcher>(async () => rowPage([], `c${++issued}`));
	await expect(readOrder(fetcher)).rejects.toMatchObject({
		code: "ordering_pagination",
	});
	expect(fetcher).toHaveBeenCalledTimes(MAX_PAGES);
});

test("ordinary discovery retains its generic page-limit code", async () => {
	let issued = 0;
	const fetcher = vi.fn<Fetcher>(async () => rowPage([], `c${++issued}`));
	await expect(
		discover(
			{
				...options,
				command: "tasks",
				all: true,
				listId: orderList,
				limit: ORDER_PAGE_LIMIT,
			},
			fetcher,
		),
	).rejects.toMatchObject({
		code: "pagination_limit",
		exitCode: 8,
		status: null,
	});
	expect(fetcher).toHaveBeenCalledTimes(MAX_PAGES);
});

test("order rows honor a signal aborted before or during discovery", async () => {
	const before = new AbortController();
	before.abort();
	const unused = vi.fn<Fetcher>(async () => rowPage([], null));
	await expect(readOrder(unused, before.signal)).rejects.toMatchObject({
		code: "cancelled",
	});
	expect(unused).not.toHaveBeenCalled();
	const during = new AbortController();
	const fetcher = vi.fn<Fetcher>(async (url) => {
		if (url.searchParams.has("cursor")) {
			during.abort();
			throw new Error("aborted");
		}
		return rowPage([orderTask("row-a")], "more");
	});
	await expect(readOrder(fetcher, during.signal)).rejects.toMatchObject({
		code: "cancelled",
	});
	expect(fetcher).toHaveBeenCalledTimes(2);
});

test("order rows refuse oversized or malformed pages without any partial result", async () => {
	const first = vi.fn<Fetcher>(async () => oversized());
	await expect(readOrder(first)).rejects.toMatchObject({
		code: "invalid_response",
	});
	expect(first).toHaveBeenCalledTimes(1);
	const second = vi.fn<Fetcher>(async (url) =>
		url.searchParams.has("cursor")
			? oversized()
			: rowPage([orderTask("a")], "b"),
	);
	await expect(readOrder(second)).rejects.toMatchObject({
		code: "invalid_response",
	});
	expect(second).toHaveBeenCalledTimes(2);
	for (const data of [
		Array.from({ length: ORDER_PAGE_LIMIT + 1 }, (_, i) => orderTask(rowId(i))),
		[{ ...orderTask("a"), sortKey: 5 }],
	]) {
		const fetcher = vi.fn<Fetcher>(async () => rowPage(data, null));
		await expect(readOrder(fetcher)).rejects.toMatchObject({
			code: "invalid_response",
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	}
});

test("ordering pages share the total byte budget and never return a partial collection", async () => {
	let bytes = 0;
	let page = 0;
	const fetcher = vi.fn<Fetcher>(async () => {
		page++;
		const data = Array.from({ length: ORDER_PAGE_LIMIT }, (_, index) => ({
			...orderTask(`page-${page}-${index}`),
			notes: "x".repeat(18_000),
		}));
		const envelope = JSON.stringify({
			version: 1,
			data,
			nextCursor: `page-${page}`,
		});
		bytes += new TextEncoder().encode(envelope).length;
		return new Response(envelope, {
			headers: { "content-type": "application/json" },
		});
	});
	await expect(readOrder(fetcher)).rejects.toMatchObject({
		code: "invalid_response",
	});
	expect(bytes).toBeGreaterThan(MAX_TOTAL_BYTES);
	expect(fetcher.mock.calls.length).toBeLessThan(MAX_PAGES);
});

const listRow = {
	id: orderList,
	workspaceId: "workspace",
	ownerId: "owner",
	title: "Groceries",
	kind: "tasks",
	icon: null,
	folderId: null,
	sortKey: "a0",
	completedDisplay: "sink",
};
const placementObservation = (taskId: string, sortKey: string) => ({
	snapshot: {
		version: 1,
		task: { ...snapshot, taskId, listId: orderList, title: `Task ${taskId}` },
		sortKey,
		parentId: null,
		list: listRow,
	},
	stateToken: "c".repeat(64),
	childrenState: children,
});
const listObservation = { snapshot: listRow, stateToken: "d".repeat(64) };

test("observed placement and list tokens reach the placement body that will be reviewed", async () => {
	const rows = [orderTask("row-a"), orderTask("row-b"), doneTask("row-c")].map(
		(row, index) => ({ ...row, sortKey: `a${index}` }),
	);
	const fetcher = vi.fn<Fetcher>(async (url) => {
		if (url.pathname === "/api/v1/tasks") return rowPage(rows, null);
		if (url.pathname.endsWith("/placement-observation"))
			return result(placementObservation("row-b", "a1"));
		return result(listObservation);
	});
	const api = terminalApi(options, fetcher);
	const signal = new AbortController().signal;
	const all = await api.orderRows(orderList, signal);
	const placement = await api.observePlacement("row-b", signal);
	const list = await api.observeList(orderList, signal);
	expect(fetcher).toHaveBeenCalledTimes(3);
	const [, placementCall, listCall] = fetcher.mock.calls;
	expect(placementCall[0].pathname).toBe(
		"/api/v1/tasks/row-b/placement-observation",
	);
	expect(placementCall[1].method).toBe("GET");
	expect(listCall[0].pathname).toBe(
		`/api/v1/lists/${encodeURIComponent(orderList)}/observation`,
	);
	expect(listCall[1].method).toBe("GET");
	const proposal = proposeOrdering(
		planOrdering({
			rows: all,
			taskId: "row-b",
			listId: orderList,
			placement,
			list,
		}),
		3,
	);
	expect(proposal.body).toEqual({
		workspaceId: "workspace",
		listId: orderList,
		expectedState: "c".repeat(64),
		targetListId: orderList,
		expectedTargetState: "d".repeat(64),
		sortKey: proposal.order.key,
		cascadeChildren: false,
		expectedChildrenState: null,
	});
	expect(proposal.order.after?.id).toBe("row-c");
	expect(proposal.order.before).toBeNull();
	expect(proposal.order.key > "a2").toBe(true);
});

test("a placement observation for another task is refused after one read", async () => {
	const fetcher = vi.fn<Fetcher>(async () =>
		result(placementObservation("row-b", "a1")),
	);
	await expect(
		terminalApi(options, fetcher).observePlacement(
			"row-z",
			new AbortController().signal,
		),
	).rejects.toMatchObject({ code: "invalid_response" });
	expect(fetcher).toHaveBeenCalledTimes(1);
});

const placeBody = {
	workspaceId: "workspace",
	listId: "list",
	expectedState: "a".repeat(64),
	targetListId: "list",
	expectedTargetState: "b".repeat(64),
	sortKey: "a5",
	cascadeChildren: false,
	expectedChildrenState: null,
};
const placedList = { ...listRow, id: "list" };
const ack = (
	change: Record<string, unknown> = {},
	snapshotChange: Record<string, unknown> = {},
	taskChange: Record<string, unknown> = {},
) => ({
	kind: "task-place-ack",
	originalWorkspaceId: "workspace",
	originalListId: "list",
	movedChildren: 0,
	snapshot: {
		version: 1,
		task: { ...snapshot, ...taskChange },
		sortKey: "a5",
		parentId: null,
		list: placedList,
		...snapshotChange,
	},
	...change,
});
const place = (fetcher: Fetcher) =>
	terminalApi(options, fetcher).place(
		"task",
		placeBody,
		key,
		new AbortController().signal,
	);

test("place sends exactly one PATCH with the request UUID and frozen body, then accepts the matching acknowledgement", async () => {
	const fetcher = vi.fn<Fetcher>(async () => result(ack()));
	await place(fetcher);
	expect(fetcher).toHaveBeenCalledTimes(1);
	const [url, init] = fetcher.mock.calls[0];
	expect(url.pathname).toBe("/api/v1/tasks/task/placement");
	expect(init.method).toBe("PATCH");
	expect(new Headers(init.headers).get("idempotency-key")).toBe(key);
	expect(JSON.parse(String(init.body))).toEqual(placeBody);
});

test.each([
	["a different sort key", ack({}, { sortKey: "a6" })],
	["moved children", ack({ movedChildren: 1 })],
	["another original list", ack({ originalListId: "other" })],
	["another original workspace", ack({ originalWorkspaceId: "other" })],
	["another task", ack({}, {}, { taskId: "other" })],
	["another target list", ack({}, {}, { listId: "other" })],
	["an observation instead of an acknowledgement", observation],
	["an unknown acknowledgement field", ack({ extra: true })],
])("place refuses an acknowledgement with %s and never retries", async (_name, data) => {
	const fetcher = vi.fn<Fetcher>(async () => result(data));
	await expect(place(fetcher)).rejects.toMatchObject({
		code: "invalid_response",
	});
	expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each([
	401, 403, 409, 410, 503,
])("place refusal %s is surfaced without a hidden read or retry", async (status) => {
	const fetcher = vi.fn<Fetcher>(async () => new Response(null, { status }));
	await expect(place(fetcher)).rejects.toMatchObject({ status });
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(fetcher.mock.calls[0][1].method).toBe("PATCH");
});

test("place treats a dropped connection as one uncertain attempt and never re-sends", async () => {
	const fetcher = vi.fn<Fetcher>(async () => {
		throw new Error("socket closed");
	});
	await expect(place(fetcher)).rejects.toMatchObject({
		code: "network_error",
	});
	expect(fetcher).toHaveBeenCalledTimes(1);
});

test("place refuses a malformed or cross-list body before any wire call", async () => {
	const fetcher = vi.fn<Fetcher>(async () => result(ack()));
	const api = terminalApi(options, fetcher);
	for (const body of [
		{ ...placeBody, sortKey: "0" },
		{ ...placeBody, cascadeChildren: true },
		{ ...placeBody, extra: 1 },
	])
		await expect(
			api.place(
				"task",
				body as typeof placeBody,
				key,
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: "invalid_input" });
	await expect(
		api.place("task", placeBody, "not-a-uuid", new AbortController().signal),
	).rejects.toMatchObject({ code: "invalid_input" });
	expect(fetcher).not.toHaveBeenCalled();
});
