import { describe, expect, it, vi } from "vitest";
import { CliError } from "../cli/arguments.ts";
import type { ApiTask } from "../domain/public-api-resources.ts";
import type { ApiTaskCreate } from "../domain/public-api-writes.ts";
import type { Page, TaskObservation, TerminalApi } from "./api.ts";
import { TerminalController } from "./controller.ts";
import { orderingErrorDetails } from "./index.ts";
import type { ListObservation, PlacementObservation } from "./ordering.ts";
import { orderDetails } from "./presentation.ts";
import { renderFrame, wrapLines } from "./render.ts";

const task: ApiTaskCreate = {
	listId: "list",
	title: "Milk",
	notes: null,
	dueAt: null,
	dueAllDay: false,
	priority: 0,
	assigneeIds: [],
	labelIds: [],
};
const page: Page = {
	entries: [
		{ id: "task", label: "Milk", data: { ...task, id: "task", rrule: null } },
	],
	nextCursor: null,
};
const observation: TaskObservation = {
	snapshot: {
		version: 1,
		taskId: "task",
		listId: "list",
		workspaceId: "workspace",
		title: "Milk",
		notes: "first\nsecond",
		dueAt: null,
		dueAllDay: false,
		priority: 0,
		createdAt: "2026-10-03T12:00:00.000Z",
		done: false,
		completedAt: null,
		listKind: "tasks",
		rrule: null,
		recurrenceRelative: false,
		recurrenceAnchorAt: null,
		recurrenceConsumed: null,
	},
	stateToken: "a".repeat(64),
};
const row = (id: string, sortKey: string, extra: Partial<ApiTask> = {}) => ({
	id,
	listId: "list",
	workspaceId: "workspace",
	title: `Task ${id}`,
	done: false,
	notes: null,
	dueAt: null,
	dueAllDay: false,
	priority: 0,
	completedAt: null,
	createdAt: null,
	sortKey,
	parentId: null,
	quantity: null,
	unit: null,
	category: null,
	rrule: null,
	recurrenceRelative: false,
	reminderTime: null,
	assigneeIds: [],
	labelIds: [],
	...extra,
});
// Manual order: b, task, c (done). ID order would differ.
const orderRows: ApiTask[] = [
	row("task", "a1", {
		title: observation.snapshot.title,
		notes: observation.snapshot.notes,
		createdAt: observation.snapshot.createdAt,
	}),
	row("c", "a2", { done: true }),
	row("b", "a0"),
];
const listRow = {
	id: "list",
	workspaceId: "workspace",
	ownerId: "owner",
	title: "Groceries",
	kind: "tasks" as const,
	icon: null,
	folderId: null,
	sortKey: "a0",
	completedDisplay: "sink" as const,
};
const placement: PlacementObservation = {
	snapshot: {
		version: 1,
		task: observation.snapshot,
		sortKey: "a1",
		parentId: null,
		list: listRow,
	},
	stateToken: "c".repeat(64),
	childrenState: { version: 1, count: 0, token: "b".repeat(64) },
};
const listObservation: ListObservation = {
	snapshot: listRow,
	stateToken: "d".repeat(64),
};

function fixture() {
	const api: TerminalApi = {
		observe: vi.fn(async () => structuredClone(observation)),
		observeDeletion: vi.fn(async () => ({
			...structuredClone(observation),
			childrenState: { version: 1 as const, count: 0, token: "b".repeat(64) },
		})),
		update: vi.fn(async () => {}),
		delete: vi.fn(async () => {}),
		read: vi.fn(async () => structuredClone(page)),
		orderRows: vi.fn(async () => structuredClone(orderRows)),
		observePlacement: vi.fn(async () => structuredClone(placement)),
		observeList: vi.fn(async () => structuredClone(listObservation)),
		place: vi.fn(async () => {}),
		comments: vi.fn(async () => ({ comments: [], nextCursor: null })),
		plan: vi.fn(async () => ({
			version: 1 as const,
			task: structuredClone(task),
			target: { kind: "list" as const, id: "list" },
			timezone: "Europe/Berlin",
			resolvedAt: "2026-10-03T12:00:00Z",
		})),
		create: vi.fn(async () => {}),
		complete: vi.fn(async () => {}),
	};
	const quit = vi.fn();
	const uuid = vi.fn(() => "00000000-0000-4000-8000-000000000001");
	const controller = new TerminalController(api, vi.fn(), quit, uuid);
	const text = (value: string) =>
		controller.input({ type: "text", text: value });
	const key = (value: "enter" | "escape") =>
		controller.input({ type: "key", key: value });
	return { api, controller, quit, uuid, text, key };
}

describe("terminal controller", () => {
	it.each([
		"n",
		"c",
		"?",
	])("starts a new surface at the top after scrolling detail: %s", async (command) => {
		const f = fixture();
		await f.controller.open({ resource: "tasks", listId: "list" });
		await f.key("enter");
		f.controller.setDetailLines(40);
		await f.controller.input({ type: "key", key: "end" });
		expect(f.controller.state.detailOffset).toBe(39);
		await f.text(command);
		expect(f.controller.state.detailOffset).toBe(0);
		if (command === "n")
			expect(f.controller.state.form).toMatchObject({
				field: "title",
				title: "",
			});
		if (command === "c")
			expect(f.controller.state.review?.kind).toBe("complete");
		if (command === "?") expect(f.controller.state.help).toBe(true);
	});
	it("captures loaded breadcrumb names, page positions and authority retirement without extra reads", async () => {
		const f = fixture();
		vi.mocked(f.api.read)
			.mockResolvedValueOnce({
				entries: [{ id: "workspace", label: "Household", data: {} }],
				nextCursor: null,
			})
			.mockResolvedValueOnce({
				entries: [{ id: "list", label: "Groceries", data: {} }],
				nextCursor: null,
			})
			.mockResolvedValueOnce({ ...page, nextCursor: "page-2" })
			.mockResolvedValueOnce({ ...page, nextCursor: null });
		await f.controller.open({ resource: "workspaces" });
		await f.key("enter");
		expect(f.controller.state.breadcrumb).toEqual(["Household"]);
		await f.key("enter");
		expect(f.controller.state.breadcrumb).toEqual(["Household", "Groceries"]);
		expect(f.controller.state.page).toBe(1);
		await f.text("c");
		expect(f.controller.state.review?.list).toEqual({
			id: "list",
			name: "Groceries",
		});
		expect(Object.isFrozen(f.controller.state.review?.list)).toBe(true);
		await f.key("escape");
		await f.text("p");
		expect(f.controller.state.page).toBe(2);
		expect(f.api.read).toHaveBeenCalledTimes(4);
		await f.text("?");
		await f.key("escape");
		expect(f.api.read).toHaveBeenCalledTimes(4);
		vi.mocked(f.api.read).mockRejectedValueOnce(
			new CliError("forbidden", "Refused", 4, 403),
		);
		await f.text("r");
		expect(f.controller.state.authorityRefused).toBe(true);
		expect(f.controller.state.breadcrumb).toEqual([]);
		expect(f.controller.state.page).toBe(0);
		expect(f.controller.state.entries).toEqual([]);
	});
	it("discards cancelled and late scope responses", async () => {
		const f = fixture();
		let resolve!: (page: Page) => void;
		let firstSignal!: AbortSignal;
		vi.mocked(f.api.read).mockImplementationOnce((_location, signal) => {
			firstSignal = signal;
			return new Promise((done) => {
				resolve = done;
			});
		});
		const first = f.controller.open({ resource: "tasks", listId: "old" });
		await f.controller.open({ resource: "tasks", listId: "new" });
		expect(firstSignal.aborted).toBe(true);
		resolve({
			entries: [{ id: "hidden", label: "Old account content", data: {} }],
			nextCursor: null,
		});
		await first;
		expect(f.controller.state.entries.map((row) => row.id)).toEqual(["task"]);
		expect(f.controller.state.location?.listId).toBe("new");
	});
	it("clears protected content and drafts after an authorization refusal", async () => {
		const f = fixture();
		await f.controller.open({ resource: "tasks", listId: "list" });
		await f.text("c");
		vi.mocked(f.api.complete).mockRejectedValueOnce(
			new CliError("forbidden", "Denied", 4, 403),
		);
		await f.text("y");
		expect(f.controller.state.entries).toEqual([]);
		expect(f.controller.state.review).toBeNull();
		expect(f.controller.state.detail).toBeNull();
		await f.key("enter");
		expect(f.controller.state.detail).toBeNull();
	});
	it("keeps the exact reviewed create body and request ID for an uncertain explicit retry", async () => {
		const f = fixture();
		await f.controller.open({ resource: "tasks", listId: "list" });
		await f.text("n");
		await f.controller.input({ type: "paste", text: "Milk" });
		await f.key("enter");
		await f.text("tomorrow");
		await f.key("enter");
		expect(f.api.plan).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Milk", due: { day: "tomorrow" } }),
			expect.any(AbortSignal),
		);
		expect(f.api.create).not.toHaveBeenCalled();
		await f.text("r");
		expect(f.api.create).not.toHaveBeenCalled();
		await f.controller.input({ type: "paste", text: "y\n" });
		expect(f.api.create).not.toHaveBeenCalled();
		vi.mocked(f.api.create).mockRejectedValueOnce(
			new CliError("network_error", "Uncertain", 7),
		);
		await f.text("y");
		const first = vi.mocked(f.api.create).mock.calls[0];
		expect(f.controller.state.review?.uncertain).toBe(true);
		await f.key("escape");
		expect(f.controller.state.review).not.toBeNull();
		await f.text("y");
		expect(f.api.create).toHaveBeenCalledTimes(1);
		await f.text("r");
		const second = vi.mocked(f.api.create).mock.calls[1];
		expect(second.slice(0, 2)).toEqual(first.slice(0, 2));
		expect(f.api.plan).toHaveBeenCalledTimes(1);
		expect(f.uuid).toHaveBeenCalledTimes(1);
		expect(f.controller.state.review).toBeNull();
	});
	it("completes the observed occurrence and requires a new review after conflict", async () => {
		const f = fixture();
		const occurrence = {
			...page,
			entries: [
				{
					...page.entries[0],
					data: {
						...page.entries[0].data,
						rrule: "FREQ=DAILY",
						dueAt: "2026-10-03T10:00:00Z",
					},
				},
			],
		};
		vi.mocked(f.api.read).mockResolvedValue(occurrence);
		await f.controller.open({ resource: "tasks", listId: "list" });
		await f.text("c");
		expect(f.controller.state.review).toMatchObject({
			kind: "complete",
			recurring: true,
		});
		vi.mocked(f.api.complete).mockRejectedValueOnce(
			new CliError("request_conflict", "Changed", 10, 409),
		);
		await f.text("y");
		expect(f.api.complete).toHaveBeenCalledWith(
			{ id: "task", listId: "list", dueAt: "2026-10-03T10:00:00Z" },
			expect.any(String),
			expect.any(AbortSignal),
		);
		expect(f.controller.state.review).toBeNull();
		await f.text("y");
		expect(f.api.complete).toHaveBeenCalledTimes(1);
	});
	it("rejects repeated pagination cursors and refresh starts a fresh collection", async () => {
		const f = fixture();
		vi.mocked(f.api.read).mockResolvedValue({ ...page, nextCursor: "same" });
		await f.controller.open({ resource: "tasks", listId: "list" });
		await f.text("p");
		expect(f.controller.state.error).toBe("pagination_limit");
		expect(f.controller.state.entries).toEqual([]);
		await f.text("r");
		expect(f.controller.state.status).toBe("ready");
		expect(f.controller.state.entries).toHaveLength(1);
	});
	it("close aborts pending requests and leaves no late render", async () => {
		const f = fixture();
		let signal!: AbortSignal;
		let resolve!: (page: Page) => void;
		vi.mocked(f.api.read).mockImplementationOnce((_location, current) => {
			signal = current;
			return new Promise((done) => {
				resolve = done;
			});
		});
		const loading = f.controller.open({ resource: "tasks" });
		await f.text("q");
		expect(signal.aborted).toBe(true);
		expect(f.quit).toHaveBeenCalledTimes(1);
		resolve(page);
		await loading;
		expect(f.controller.state.entries).toEqual([]);
	});
});

describe("observed terminal task mutations", () => {
	it("captures and freezes the planner body before readable and exact review", async () => {
		const f = fixture();
		const proposal = {
			version: 1 as const,
			task: structuredClone(task),
			target: { kind: "list" as const, id: "list" },
			timezone: "Europe/Berlin",
			resolvedAt: "2026-10-03T12:00:00Z",
		};
		vi.mocked(f.api.plan).mockResolvedValue(proposal);
		await f.controller.open({ resource: "tasks", listId: "list" });
		await f.text("n");
		await f.text("Milk");
		await f.key("enter");
		await f.key("enter");
		const review = f.controller.state.review;
		if (review?.kind !== "create") throw new Error("Expected create review");
		proposal.task.title = "Changed elsewhere";
		expect(review.task.title).toBe("Milk");
		expect(Object.isFrozen(review.task)).toBe(true);
		expect(Object.isFrozen(review.task.assigneeIds)).toBe(true);
		await f.text("v");
		await f.text("y");
		expect(f.api.create).toHaveBeenCalledWith(
			review.task,
			review.requestId,
			expect.any(AbortSignal),
		);
	});
	it("toggles presentation without changing the captured review or confirming from help", async () => {
		const f = fixture();
		await f.controller.open({ resource: "tasks", listId: "list" });
		await f.text("c");
		const review = f.controller.state.review;
		await f.controller.input({ type: "paste", text: "v?y" });
		expect(f.controller.state.payload).toBe(false);
		await f.text("v");
		expect(f.controller.state.payload).toBe(true);
		expect(f.controller.state.review).toBe(review);
		await f.text("?");
		await f.text("y");
		expect(f.api.complete).not.toHaveBeenCalled();
		await f.key("escape");
		expect(f.controller.state.review).toBe(review);
		await f.text("y");
		expect(f.api.complete).toHaveBeenCalledTimes(1);
		await f.text("r");
		expect(f.api.complete).toHaveBeenCalledWith(
			review?.kind === "complete" ? review.task : null,
			review?.requestId,
			expect.any(AbortSignal),
		);
	});
	it("keeps the exact uncertain request across payload toggles and clears presentation on auth refusal", async () => {
		const f = fixture();
		await f.controller.open({ resource: "tasks", listId: "list" });
		await f.text("c");
		vi.mocked(f.api.complete)
			.mockRejectedValueOnce(new CliError("network_error", "Lost", 7))
			.mockRejectedValueOnce(new CliError("forbidden", "Refused", 4, 403));
		await f.text("y");
		const review = f.controller.state.review;
		await f.text("v");
		await f.key("escape");
		expect(f.controller.state.review).toBe(review);
		await f.text("y");
		expect(f.api.complete).toHaveBeenCalledTimes(1);
		await f.text("r");
		expect(vi.mocked(f.api.complete).mock.calls[1].slice(0, 2)).toEqual(
			vi.mocked(f.api.complete).mock.calls[0].slice(0, 2),
		);
		expect(f.controller.state.review).toBeNull();
		expect(f.controller.state.entries).toEqual([]);
	});
	const open = async () => {
		const f = fixture();
		await f.controller.open({ resource: "tasks", listId: "list" });
		return f;
	};
	const finishEdit = async (f: ReturnType<typeof fixture>, fields = 5) => {
		for (let i = 0; i < fields; i++) await f.key("enter");
	};
	it("observes explicitly, preserves multiline notes, and reviews only the changed title", async () => {
		const f = await open();
		await f.text("e");
		expect(f.api.observe).toHaveBeenCalledWith("task", expect.any(AbortSignal));
		expect(f.controller.state.form).toMatchObject({
			kind: "update",
			notes: "first\nsecond",
		});
		await f.text("!");
		await finishEdit(f);
		expect(f.controller.state.review).toMatchObject({
			kind: "update",
			body: {
				listId: "list",
				expectedState: "a".repeat(64),
				patch: { title: "Milk!" },
			},
		});
		expect(
			Object.keys(
				f.controller.state.review?.kind === "update"
					? f.controller.state.review.body.patch
					: {},
			),
		).toEqual(["title"]);
		await f.controller.input({ type: "paste", text: "y" });
		expect(f.api.update).not.toHaveBeenCalled();
		await f.text("y");
		expect(f.api.update).toHaveBeenCalledTimes(1);
		expect(f.api.observe).toHaveBeenCalledTimes(1);
	});
	it("an unchanged edit creates no UUID or proposal", async () => {
		const f = await open();
		await f.text("e");
		await finishEdit(f);
		expect(f.controller.state.error).toBe("no_changes");
		expect(f.controller.state.review).toBeNull();
		expect(f.uuid).not.toHaveBeenCalled();
	});
	it("normalizes multiline pasted notes while keeping pasted keys literal", async () => {
		const f = await open();
		await f.text("e");
		await f.key("enter");
		await f.controller.input({ type: "paste", text: "\r\ny\nnext" });
		await finishEdit(f, 4);
		expect(f.controller.state.review).toMatchObject({
			body: { patch: { notes: "first\nsecond\ny\nnext" } },
		});
		expect(f.api.update).not.toHaveBeenCalled();
	});
	it("clears an observed due instant and its all-day flag together", async () => {
		const f = await open();
		vi.mocked(f.api.observe).mockResolvedValue({
			...observation,
			snapshot: {
				...observation.snapshot,
				dueAt: "2026-10-04T10:00:00.000Z",
				dueAllDay: true,
			},
		});
		await f.text("e");
		await finishEdit(f, 2);
		for (let i = 0; i < 24; i++)
			await f.controller.input({ type: "key", key: "backspace" });
		await finishEdit(f, 3);
		expect(f.controller.state.review).toMatchObject({
			body: { patch: { dueAt: null, dueAllDay: false } },
		});
	});
	it.each([
		"recurring",
		"habit",
	])("skips unavailable due fields for a %s task", async (kind) => {
		const f = await open();
		vi.mocked(f.api.observe).mockResolvedValue({
			...observation,
			snapshot: {
				...observation.snapshot,
				rrule: kind === "recurring" ? "FREQ=DAILY" : null,
				listKind: kind === "habit" ? "habits" : "tasks",
			},
		});
		await f.text("e");
		await finishEdit(f, 2);
		expect(f.controller.state.form?.field).toBe("priority");
		await f.controller.input({ type: "key", key: "backspace" });
		await f.text("2");
		await f.key("enter");
		expect(f.controller.state.review).toMatchObject({
			body: { patch: { priority: 2 } },
		});
	});
	it("keeps an immutable exact patch and UUID on uncertainty without observing again", async () => {
		const f = await open();
		await f.text("e");
		await f.text("!");
		await finishEdit(f);
		const review = f.controller.state.review;
		if (review?.kind !== "update") throw new Error("Expected update review");
		expect(Object.isFrozen(review.body)).toBe(true);
		expect(Object.isFrozen(review.body.patch)).toBe(true);
		vi.mocked(f.api.update).mockRejectedValueOnce(
			new CliError("network_error", "Lost", 7),
		);
		await f.text("y");
		await f.key("escape");
		await f.text("e");
		await f.text("y");
		expect(f.api.update).toHaveBeenCalledTimes(1);
		await f.text("r");
		const calls = vi.mocked(f.api.update).mock.calls;
		expect(calls[1].slice(0, 3)).toEqual(calls[0].slice(0, 3));
		expect(f.api.observe).toHaveBeenCalledTimes(1);
		expect(f.uuid).toHaveBeenCalledTimes(1);
	});
	it("requires a typed cascade choice and separate review before deletion", async () => {
		const f = await open();
		vi.mocked(f.api.observeDeletion).mockResolvedValue({
			...observation,
			childrenState: { version: 1, count: 2, token: "b".repeat(64) },
		});
		await f.text("d");
		await f.controller.input({ type: "paste", text: "2\ny" });
		await f.key("enter");
		expect(f.controller.state.review).toBeNull();
		await f.text("1");
		await f.key("enter");
		expect(f.controller.state.review).toBeNull();
		await f.text("2");
		await f.key("enter");
		expect(f.controller.state.review).toMatchObject({
			kind: "delete",
			body: { cascadeChildren: true, expectedChildrenState: { count: 2 } },
		});
		await f.controller.input({ type: "paste", text: "y" });
		expect(f.api.delete).not.toHaveBeenCalled();
		await f.text("y");
		expect(f.api.delete).toHaveBeenCalledTimes(1);
	});
	it("supports explicit no-cascade deletion and preserves the exact retry guards", async () => {
		const f = await open();
		await f.text("d");
		await f.text("1");
		await f.key("enter");
		const review = f.controller.state.review;
		if (review?.kind !== "delete") throw new Error("Expected deletion review");
		expect(review.body.cascadeChildren).toBe(false);
		expect(Object.isFrozen(review.body.expectedChildrenState)).toBe(true);
		vi.mocked(f.api.delete).mockRejectedValueOnce(
			new CliError("network_error", "Lost", 7),
		);
		await f.text("y");
		await f.text("y");
		expect(f.api.delete).toHaveBeenCalledTimes(1);
		await f.text("r");
		expect(vi.mocked(f.api.delete).mock.calls[1].slice(0, 3)).toEqual(
			vi.mocked(f.api.delete).mock.calls[0].slice(0, 3),
		);
		expect(f.api.observeDeletion).toHaveBeenCalledTimes(1);
	});
	it.each([
		"update",
		"delete",
	] as const)("invalidates a %s proposal after conflict and clears it after authorization refusal", async (kind) => {
		const f = await open();
		const review = async () => {
			await f.text(kind === "update" ? "e" : "d");
			if (kind === "update") {
				await f.text("!");
				await finishEdit(f);
			} else {
				await f.text("1");
				await f.key("enter");
			}
		};
		await review();
		vi.mocked(f.api[kind]).mockRejectedValueOnce(
			new CliError("request_conflict", "Changed", 10, 409),
		);
		await f.text("y");
		expect(f.controller.state.review).toBeNull();
		await f.text("y");
		expect(f.api[kind]).toHaveBeenCalledTimes(1);
		await f.text("r");
		await review();
		vi.mocked(f.api[kind]).mockRejectedValueOnce(
			new CliError("forbidden", "Revoked", 4, 403),
		);
		await f.text("y");
		expect(f.controller.state.entries).toEqual([]);
		expect(f.controller.state.form).toBeNull();
		expect(f.controller.state.deletion).toBeNull();
	});
	it("cancelled observations cannot populate a different scope", async () => {
		const f = await open();
		let resolve!: (value: TaskObservation) => void;
		let signal!: AbortSignal;
		vi.mocked(f.api.observe).mockImplementationOnce((_id, current) => {
			signal = current;
			return new Promise((done) => {
				resolve = done;
			});
		});
		const pending = f.text("e");
		await f.controller.open({ resource: "tasks", listId: "other" });
		resolve(observation);
		await pending;
		expect(signal.aborted).toBe(true);
		expect(f.controller.state.form).toBeNull();
		expect(f.uuid).not.toHaveBeenCalled();
	});
});

describe("same-list ordering", () => {
	async function ordering() {
		const f = fixture();
		await f.controller.open({ resource: "tasks", listId: "list" });
		await f.text("o");
		return f;
	}
	const type = async (
		f: Awaited<ReturnType<typeof ordering>>,
		text: string,
	) => {
		for (const digit of text) await f.text(digit);
	};

	it("shows the manual sibling order, not the ID order, and sends nothing to open", async () => {
		const f = await ordering();
		const plan = f.controller.state.ordering?.plan;
		expect(plan?.siblings.map((row) => row.id)).toEqual(["b", "task", "c"]);
		expect(plan?.index).toBe(1);
		expect(f.api.orderRows).toHaveBeenCalledTimes(1);
		expect(f.api.observePlacement).toHaveBeenCalledTimes(1);
		expect(f.api.observeList).toHaveBeenCalledTimes(1);
		expect(f.api.place).not.toHaveBeenCalled();
	});
	it("accepts bounded typed digits only and ignores paste", async () => {
		const f = await ordering();
		await f.controller.input({ type: "paste", text: "1\ny" });
		await type(f, "0");
		await type(f, "9");
		await type(f, "x");
		expect(f.controller.state.ordering?.position).toBe("");
		await type(f, "3");
		await f.controller.input({ type: "key", key: "backspace" });
		expect(f.controller.state.ordering?.position).toBe("");
		await f.key("enter");
		expect(f.controller.state.review).toBeNull();
		expect(f.controller.state.error).toBe("invalid_input");
		expect(f.api.place).not.toHaveBeenCalled();
	});
	it("refuses an unchanged position without a request or review", async () => {
		const f = await ordering();
		await type(f, "2");
		await f.key("enter");
		expect(f.controller.state.error).toBe("ordering_unchanged");
		expect(f.controller.state.review).toBeNull();
		const currentOrdering = f.controller.state.ordering;
		if (!currentOrdering?.plan) throw new Error("Expected active order prompt");
		const details = [
			...orderingErrorDetails(f.controller.state, "en", 40),
			...wrapLines(
				orderDetails(currentOrdering.plan, currentOrdering.position, {
					locale: "en",
					timezone: "UTC",
					now: 0,
					ascii: true,
				}),
				39,
			),
		];
		const frame = renderFrame(
			{
				title: "Order",
				status: "Error",
				footer: "Enter continue",
				rows: [],
				selected: 0,
				framed: true,
				detail: details,
			},
			40,
			20,
		);
		expect(frame.replace(/\s+/g, " ")).toContain(
			"Nothing was sent. Choose another position.",
		);
		expect(frame).toContain("> 2");
		expect(frame).not.toContain("Press o");
		expect(f.api.place).not.toHaveBeenCalled();
	});
	it("freezes the key and body in a review and sends one PATCH on typed y", async () => {
		const f = await ordering();
		await type(f, "1");
		await f.key("enter");
		const review = f.controller.state.review;
		if (review?.kind !== "place") throw new Error("Expected order review");
		expect(f.controller.state.ordering).toBeNull();
		expect(review.order).toMatchObject({
			from: 2,
			to: 1,
			total: 3,
			after: null,
		});
		expect(review.order.before?.id).toBe("b");
		expect(review.body).toMatchObject({
			listId: "list",
			targetListId: "list",
			expectedState: "c".repeat(64),
			expectedTargetState: "d".repeat(64),
			cascadeChildren: false,
			expectedChildrenState: null,
			sortKey: review.order.key,
		});
		expect(review.order.key < "a0").toBe(true);
		expect(Object.isFrozen(review.body)).toBe(true);
		await f.controller.input({ type: "paste", text: "y" });
		await f.text("?");
		await f.text("y");
		expect(f.api.place).not.toHaveBeenCalled();
		await f.text("?");
		await f.text("y");
		expect(f.api.place).toHaveBeenCalledTimes(1);
		expect(vi.mocked(f.api.place).mock.calls[0].slice(0, 3)).toEqual([
			"task",
			review.body,
			"00000000-0000-4000-8000-000000000001",
		]);
		expect(f.controller.state.review).toBeNull();
		expect(f.controller.state.ordered).toEqual({ to: 1, total: 3 });
		await f.controller.input({ type: "key", key: "down" });
		expect(f.controller.state.ordered).toBeNull();
	});
	it("keeps the exact body and UUID for a manual retry after an uncertain result", async () => {
		const f = await ordering();
		await type(f, "3");
		await f.key("enter");
		vi.mocked(f.api.place).mockRejectedValueOnce(
			new CliError("network_error", "Lost", 7),
		);
		await f.text("y");
		await f.text("y");
		await f.key("escape");
		expect(f.api.place).toHaveBeenCalledTimes(1);
		expect(f.controller.state.review?.uncertain).toBe(true);
		await f.text("r");
		expect(f.api.place).toHaveBeenCalledTimes(2);
		expect(vi.mocked(f.api.place).mock.calls[1].slice(0, 3)).toEqual(
			vi.mocked(f.api.place).mock.calls[0].slice(0, 3),
		);
		expect(f.api.orderRows).toHaveBeenCalledTimes(1);
	});
	it("clears the review on 409 and everything on authorization refusal", async () => {
		const f = await ordering();
		await type(f, "1");
		await f.key("enter");
		vi.mocked(f.api.place).mockRejectedValueOnce(
			new CliError("request_conflict", "Changed", 10, 409),
		);
		await f.text("y");
		expect(f.controller.state.review).toBeNull();
		expect(f.controller.state.ordering).toBeNull();
		await f.text("r");
		await f.text("o");
		await type(f, "1");
		await f.key("enter");
		vi.mocked(f.api.place).mockRejectedValueOnce(
			new CliError("forbidden", "Revoked", 4, 403),
		);
		await f.text("y");
		expect(f.controller.state.entries).toEqual([]);
		expect(f.controller.state.review).toBeNull();
		expect(f.controller.state.ordering).toBeNull();
		expect(f.controller.state.ordered).toBeNull();
	});
	it("cancels a pending read and ignores late replies", async () => {
		const f = fixture();
		await f.controller.open({ resource: "tasks", listId: "list" });
		let resolve!: (rows: ApiTask[]) => void;
		let signal!: AbortSignal;
		vi.mocked(f.api.orderRows).mockImplementationOnce((_id, current) => {
			signal = current;
			return new Promise((done) => {
				resolve = done;
			});
		});
		const pending = f.text("o");
		await f.key("escape");
		resolve(structuredClone(orderRows));
		await pending;
		expect(signal.aborted).toBe(true);
		expect(f.controller.state.ordering).toBeNull();
		expect(f.api.observePlacement).not.toHaveBeenCalled();
		expect(f.controller.state.location?.listId).toBe("list");
	});
	it("refuses tied keys before any review", async () => {
		const f = fixture();
		vi.mocked(f.api.orderRows).mockResolvedValueOnce([
			structuredClone(orderRows[0]),
			row("b", "a1"),
		]);
		await f.controller.open({ resource: "tasks", listId: "list" });
		await f.text("o");
		expect(f.controller.state.error).toBe("ordering_tied");
		expect(f.controller.state.ordering).toBeNull();
		expect(f.api.place).not.toHaveBeenCalled();
		const frame = renderFrame(
			{
				title: "Order",
				status: "Error",
				footer: "o reorder",
				rows: [],
				selected: 0,
				framed: true,
				detail: orderingErrorDetails(f.controller.state, "en", 40),
			},
			40,
			20,
		);
		const visible = frame.replace(/\s+/g, " ");
		expect(visible).toContain("Nothing was sent.");
		expect(visible).toContain("Press r to reload, then o to read the order.");
		expect(visible).not.toContain("Esc");
		await f.text("o");
		expect(f.api.orderRows).toHaveBeenCalledTimes(1);
		await f.text("r");
		expect(f.controller.state.status).toBe("ready");
		await f.text("o");
		expect(f.api.orderRows).toHaveBeenCalledTimes(2);
	});
});
