import { describe, expect, it, vi } from "vitest";
import { CliError } from "../cli/arguments.ts";
import type { ApiTaskCreate } from "../domain/public-api-writes.ts";
import type { Page, TerminalApi } from "./api.ts";
import { TerminalController } from "./controller.ts";

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
function fixture() {
	const api: TerminalApi = {
		read: vi.fn(async () => structuredClone(page)),
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
