import { describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard.ts";

// No DOM environment in this suite (see vitest.config.ts) -- a document-shaped
// stub exercises the selection path without needing a real one.
function fakeDoc(execResult = true) {
	const appended: Array<Record<string, unknown>> = [];
	const selected: string[] = [];
	let removed = 0;
	const doc = {
		createElement: () => {
			const el: Record<string, unknown> = {
				value: "",
				style: {},
				setAttribute: () => {},
				select: () => selected.push(String(el.value)),
				remove: () => {
					removed++;
				},
			};
			return el;
		},
		body: {
			appendChild: (el: Record<string, unknown>) => appended.push(el),
		},
		execCommand: () => execResult,
	} as unknown as Document;
	return { doc, appended, selected, removed: () => removed };
}

describe("copyText", () => {
	it("uses the async clipboard when the context is secure", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		const { doc, appended } = fakeDoc();
		await expect(
			copyText("link", { writer: { writeText }, doc }),
		).resolves.toBe(true);
		expect(writeText).toHaveBeenCalledWith("link");
		// The fallback must not also run, or the page briefly steals focus.
		expect(appended).toHaveLength(0);
	});

	it("still copies with no clipboard API at all", async () => {
		const { doc, selected } = fakeDoc();
		await expect(copyText("link", { writer: undefined, doc })).resolves.toBe(
			true,
		);
		expect(selected).toEqual(["link"]);
	});

	it("falls back when the clipboard API rejects", async () => {
		const writeText = vi.fn().mockRejectedValue(new Error("denied"));
		const { doc, selected } = fakeDoc();
		await expect(
			copyText("link", { writer: { writeText }, doc }),
		).resolves.toBe(true);
		expect(selected).toEqual(["link"]);
	});

	it("reports failure rather than a copy that did not happen", async () => {
		const { doc } = fakeDoc(false);
		await expect(copyText("link", { writer: undefined, doc })).resolves.toBe(
			false,
		);
	});

	it("removes the scratch field even when the copy fails", async () => {
		const { doc, removed } = fakeDoc(false);
		await copyText("link", { writer: undefined, doc });
		expect(removed()).toBe(1);
	});
});
