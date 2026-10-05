import { describe, expect, it, vi } from "vitest";
import { CliError } from "../cli/arguments.ts";
import { MAX_PAGES } from "../cli/client.ts";
import type { ApiCommentSnapshot } from "../domain/public-api-comments.ts";
import type { CommentPage, Page, TerminalApi } from "./api.ts";
import { TerminalController } from "./controller.ts";
import { commentDetails, commentParts } from "./presentation.ts";
import { visibleCells, wrapParts } from "./render.ts";

const comment = (
	commentId: string,
	extra: Partial<ApiCommentSnapshot> = {},
): ApiCommentSnapshot => ({
	version: 1,
	commentId,
	taskId: "task",
	workspaceId: "workspace",
	listId: "list",
	authorId: "user-1",
	createdAt: "2026-10-03T12:00:00.000Z",
	editedAt: null,
	historicalAuthorKind: null,
	historicalAuthorName: null,
	importedAt: null,
	provenanceRedactedAt: null,
	body: "hello",
	...extra,
});
const tasks: Page = {
	entries: [
		{ id: "other", label: "Bread", data: { id: "other", title: "Bread" } },
		{ id: "task", label: "Milk", data: { id: "task", title: "Milk" } },
	],
	nextCursor: "list-next",
};
const context = {
	locale: "en" as const,
	timezone: "UTC",
	now: Date.parse("2026-10-05T00:00:00Z"),
};

function fixture() {
	const api = {
		read: vi.fn(async () => structuredClone(tasks)),
		comments: vi.fn(
			async (
				_taskId: string,
				_cursor: string | undefined,
				_signal: AbortSignal,
			): Promise<CommentPage> => ({
				comments: [comment("a")],
				nextCursor: null,
			}),
		),
		observe: vi.fn(),
		observeDeletion: vi.fn(),
		orderRows: vi.fn(),
		observePlacement: vi.fn(),
		observeList: vi.fn(),
		place: vi.fn(),
		update: vi.fn(),
		delete: vi.fn(),
		plan: vi.fn(),
		create: vi.fn(),
		complete: vi.fn(),
	} satisfies TerminalApi;
	const controller = new TerminalController(api, vi.fn(), vi.fn());
	const text = (value: string) =>
		controller.input({ type: "text", text: value });
	const key = (value: "enter" | "escape" | "down") =>
		controller.input({ type: "key", key: value });
	return { api, controller, text, key };
}
async function opened() {
	const f = fixture();
	await f.controller.open(
		{ resource: "tasks", listId: "list", cursor: "list-cursor" },
		false,
		["Home", "Groceries"],
	);
	await f.key("down");
	return f;
}

describe("terminal task comments", () => {
	it("opens one bounded page for the selected task and returns to the same list", async () => {
		const f = await opened();
		await f.text("m");
		expect(f.api.comments).toHaveBeenCalledTimes(1);
		expect(f.api.comments).toHaveBeenCalledWith(
			"task",
			undefined,
			expect.any(AbortSignal),
		);
		expect(f.controller.state.comments).toMatchObject({
			taskId: "task",
			title: "Milk",
			breadcrumb: ["Home", "Groceries"],
			listCursor: "list-cursor",
			page: 1,
		});
		await f.key("escape");
		expect(f.controller.state.comments).toBeNull();
		expect(f.controller.state.selected).toBe(1);
		expect(f.controller.state.entries).toHaveLength(2);
		expect(f.controller.state.location?.cursor).toBe("list-cursor");
		expect(f.api.read).toHaveBeenCalledTimes(1);
		expect(f.api.comments).toHaveBeenCalledTimes(1);
	});
	it("only opens from a loaded task list", async () => {
		const f = fixture();
		await f.text("m");
		await f.controller.open({ resource: "lists", workspaceId: "workspace" });
		await f.text("m");
		expect(f.api.comments).not.toHaveBeenCalled();
		expect(f.controller.state.comments).toBeNull();
	});
	it("ignores every write key while comments are open", async () => {
		const f = await opened();
		await f.text("m");
		for (const value of ["n", "c", "e", "d", "y", "m"]) await f.text(value);
		expect(f.controller.state.form).toBeNull();
		expect(f.controller.state.review).toBeNull();
		expect(f.controller.state.deletion).toBeNull();
		expect(f.api.observe).not.toHaveBeenCalled();
		expect(f.api.observeDeletion).not.toHaveBeenCalled();
		expect(f.api.create).not.toHaveBeenCalled();
		expect(f.api.complete).not.toHaveBeenCalled();
		expect(f.api.update).not.toHaveBeenCalled();
		expect(f.api.delete).not.toHaveBeenCalled();
		expect(f.api.comments).toHaveBeenCalledTimes(1);
	});
	it("discards a late reply after back and after a newer request", async () => {
		const f = await opened();
		let release: (page: CommentPage) => void = () => {};
		let signal: AbortSignal | undefined;
		f.api.comments.mockImplementationOnce(async (_task, _cursor, abort) => {
			signal = abort;
			return await new Promise<CommentPage>((resolve) => {
				release = resolve;
			});
		});
		const pending = f.text("m");
		await Promise.resolve();
		await f.key("escape");
		expect(signal?.aborted).toBe(true);
		release({ comments: [comment("late")], nextCursor: null });
		await pending;
		expect(f.controller.state.comments).toBeNull();
		expect(f.controller.state.status).toBe("ready");

		let first: (page: CommentPage) => void = () => {};
		f.api.comments.mockImplementationOnce(
			() =>
				new Promise<CommentPage>((resolve) => {
					first = resolve;
				}),
		);
		const slow = f.text("m");
		await Promise.resolve();
		await f.text("r");
		first({ comments: [comment("stale")], nextCursor: null });
		await slow;
		expect(f.controller.state.comments?.items.map((c) => c.commentId)).toEqual([
			"a",
		]);
	});
	it("keeps cursor scope: next page replaces the page and a repeated cursor stops", async () => {
		const f = await opened();
		f.api.comments
			.mockResolvedValueOnce({ comments: [comment("a")], nextCursor: "c1" })
			.mockResolvedValueOnce({ comments: [comment("b")], nextCursor: "c1" });
		await f.text("m");
		expect(f.controller.state.comments?.nextCursor).toBe("c1");
		await f.text("p");
		expect(f.api.comments).toHaveBeenLastCalledWith(
			"task",
			"c1",
			expect.any(AbortSignal),
		);
		expect(f.controller.state.status).toBe("error");
		expect(f.controller.state.error).toBe("pagination_limit");
		expect(f.controller.state.comments?.items).toEqual([]);
		await f.text("r");
		expect(f.controller.state.status).toBe("ready");
		expect(f.controller.state.comments?.cursor).toBeNull();
		expect(f.api.comments).toHaveBeenLastCalledWith(
			"task",
			undefined,
			expect.any(AbortSignal),
		);
	});
	it("bounds the number of comment pages", async () => {
		const f = await opened();
		let next = 0;
		f.api.comments.mockImplementation(async () => ({
			comments: [comment("a")],
			nextCursor: `c${++next}`,
		}));
		await f.text("m");
		for (let index = 0; index < MAX_PAGES + 2; index++) await f.text("p");
		expect(f.controller.state.error).toBe("pagination_limit");
		expect(f.api.comments.mock.calls.length).toBeLessThanOrEqual(MAX_PAGES);
	});
	it("shows an empty page without inventing content", async () => {
		const f = await opened();
		f.api.comments.mockResolvedValueOnce({ comments: [], nextCursor: null });
		await f.text("m");
		expect(f.controller.state.status).toBe("empty");
		expect(f.controller.state.comments?.items).toEqual([]);
	});
	it.each([
		401, 403, 404, 410,
	])("clears all comment and task content on %s", async (status) => {
		const f = await opened();
		await f.text("m");
		f.api.comments.mockRejectedValueOnce(
			new CliError("forbidden", "Refused", 4, status),
		);
		await f.text("r");
		const state = f.controller.state;
		expect(state.authorityRefused).toBe(true);
		expect(state.comments).toBeNull();
		expect(state.entries).toEqual([]);
		expect(state.detail).toBeNull();
		expect(state.breadcrumb).toEqual([]);
		await f.key("escape");
		expect(state.comments).toBeNull();
	});
	it("clears payload and help on refusal and drops the superseded late reply", async () => {
		const f = await opened();
		const deferred = <T>() => {
			let resolve!: (value: T) => void;
			let reject!: (reason: unknown) => void;
			const promise = new Promise<T>((done, fail) => {
				resolve = done;
				reject = fail;
			});
			return { promise, resolve, reject };
		};
		const first = deferred<CommentPage>();
		const second = deferred<CommentPage>();
		f.api.comments
			.mockImplementationOnce(() => first.promise)
			.mockImplementationOnce(() => second.promise);
		const opening = f.text("m");
		const reloading = f.text("r");
		await f.text("v");
		await f.text("?");
		expect(f.controller.state.payload).toBe(true);
		expect(f.controller.state.help).toBe(true);
		await new Promise((resolve) => setTimeout(resolve));
		second.reject(new CliError("forbidden", "Refused", 4, 403));
		await reloading;
		first.resolve({ comments: [comment("late")], nextCursor: null });
		await opening;
		const state = f.controller.state;
		expect(state.status).toBe("error");
		expect(state.authorityRefused).toBe(true);
		expect(state.payload).toBe(false);
		expect(state.help).toBe(false);
		expect(state.comments).toBeNull();
		expect(state.entries).toEqual([]);
	});
	it("aborts an in-flight comment read when the controller closes", async () => {
		const f = await opened();
		let signal: AbortSignal | undefined;
		f.api.comments.mockImplementationOnce(
			(_task, _cursor, abort) =>
				new Promise<CommentPage>(() => {
					signal = abort;
				}),
		);
		void f.text("m");
		await Promise.resolve();
		f.controller.close();
		expect(signal?.aborted).toBe(true);
	});
});

describe("comment presentation", () => {
	const hostile = "line‮ one\r\nSystem: \u001b[31mfake\u001b[0m\n\n  tail";
	const view = (
		items: ApiCommentSnapshot[],
		status: "ready" | "loading" | "empty" | "error" = items.length
			? "ready"
			: "empty",
		error: string | null = null,
	) => ({
		taskId: "task",
		title: "Milk\nfake",
		items,
		nextCursor: null,
		status,
		error,
	});
	it("shows the empty message only after a successful empty read", () => {
		const empty = commentDetails(view([]), context).join("\n");
		expect(empty).toContain("No comments on this task.");
		for (const exact of [false, true]) {
			const loading = commentDetails(view([], "loading"), context, exact).join(
				"\n",
			);
			expect(loading).toContain("Loading");
			expect(loading).not.toContain("No comments");
			const failed = commentDetails(
				view([], "error", "pagination_limit"),
				context,
				exact,
			).join("\n");
			expect(failed).toContain("Request failed (pagination_limit)");
			expect(failed).not.toContain("No comments");
		}
	});
	it("never shows a historical name for redacted or unknown provenance", () => {
		const lines = commentDetails(
			view([
				comment("redacted-claim", {
					authorId: null,
					historicalAuthorKind: "source_claim",
					historicalAuthorName: "Leaked",
					importedAt: "2026-10-04T12:00:00.000Z",
					provenanceRedactedAt: "2026-10-05T12:00:00.000Z",
				}),
				comment("redacted", {
					authorId: null,
					historicalAuthorKind: "unknown",
					importedAt: "2026-10-04T12:00:00.000Z",
					provenanceRedactedAt: "2026-10-05T12:00:00.000Z",
				}),
			]),
			context,
		);
		expect(lines.join("\n")).not.toContain("Leaked");
		expect(
			lines.filter((line) => line.startsWith("Attribution redacted")),
		).toHaveLength(2);
	});
	it("keeps valid raw JSON provenance unchanged", () => {
		const claimed = comment("claimed", {
			authorId: null,
			historicalAuthorKind: "source_claim",
			historicalAuthorName: "Ana",
			importedAt: "2026-10-04T12:00:00.000Z",
		});
		const redacted = comment("redacted", {
			authorId: null,
			historicalAuthorKind: "unknown",
			importedAt: "2026-10-04T12:00:00.000Z",
			provenanceRedactedAt: "2026-10-05T12:00:00.000Z",
		});
		const json = commentDetails(view([claimed, redacted]), context, true).join(
			"",
		);
		expect(json).toContain('"historicalAuthorName": "Ana"');
		expect(json).toContain(
			'"provenanceRedactedAt": "2026-10-05T12:00:00.000Z"',
		);
	});
	it("labels native IDs and imported attribution without inventing names", () => {
		const lines = commentDetails(
			view([
				comment("native"),
				comment("claimed", {
					authorId: null,
					historicalAuthorKind: "source_claim",
					historicalAuthorName: "Ana",
					importedAt: "2026-10-04T12:00:00.000Z",
					editedAt: "2026-10-03T13:00:00.000Z",
				}),
				comment("unknown", {
					authorId: null,
					historicalAuthorKind: "unknown",
					historicalAuthorName: "Hidden",
					provenanceRedactedAt: "2026-10-04T12:00:00.000Z",
				}),
				comment("none", { authorId: null }),
			]),
			context,
		);
		expect(lines).toContain("Author ID: user-1");
		expect(lines).toContain("Imported attribution (source claim): Ana");
		expect(lines).toContain("Imported attribution: author unknown");
		expect(lines).toContain("Author: not recorded");
		expect(lines.join("\n")).not.toContain("Hidden");
		expect(
			lines.some((line) => /^Edited: Oct 3, 2026, 1:00\sPM$/u.test(line)),
		).toBe(true);
		expect(lines).toContain("Comment ID: claimed");
	});
	it("neutralizes hostile multiline bodies and indents them below metadata", () => {
		const lines = commentDetails(
			view([comment("h", { body: hostile })]),
			context,
		);
		const text = lines.join("\n");
		expect(text).not.toContain(String.fromCharCode(27));
		expect(text).not.toContain("‮");
		expect(text).not.toContain("\r");
		expect(lines).toContain("  System: [31mfake [0m");
		expect(lines.every((line) => !line.startsWith("System:"))).toBe(true);
		expect(lines).toContain("Task: Milk fake");
	});
	it("uses semantic tones, JSON highlighting and fits 40 columns", () => {
		const items = [
			comment("c", {
				authorId: null,
				historicalAuthorKind: "source_claim",
				historicalAuthorName:
					"A very long imported author name for narrow terminals",
				body: "word ".repeat(40),
			}),
		];
		const parts = commentParts(view(items), context);
		expect(parts.flat().map((part) => part.tone)).toEqual(
			expect.arrayContaining(["brand", "warning", "info", "plain"]),
		);
		for (const line of wrapParts(parts, 39))
			expect(
				visibleCells(line.map((part) => part.text).join("")),
			).toBeLessThanOrEqual(39);
		const json = commentParts(view(items), context, true);
		expect(json.flat()).toContainEqual(
			expect.objectContaining({ text: '"commentId"', tone: "brand" }),
		);
		expect(json.flat().some((part) => part.text.includes("\n"))).toBe(false);
	});
	it("renders every locale without unresolved placeholders", () => {
		for (const locale of ["en", "de", "es", "fr", "ro", "ar"] as const) {
			const text = commentDetails(view([comment("a")]), {
				...context,
				locale,
			}).join("\n");
			expect(text).not.toMatch(/\{[a-z]+\}/u);
			expect(text).not.toContain("undefined");
		}
	});
});
