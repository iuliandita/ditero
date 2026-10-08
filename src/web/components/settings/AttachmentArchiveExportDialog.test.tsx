import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FilePickerCancelledError } from "../../lib/e2e/download.ts";
import { AttachmentArchiveExportDialog } from "./AttachmentArchiveExportDialog.tsx";

const fixture = vi.hoisted(() => ({
	states: [] as unknown[],
	refs: [] as { current: unknown }[],
	state: 0,
	ref: 0,
	mounted: false,
	effects: [] as (() => (() => void) | undefined)[],
	cleanups: [] as (() => void)[],
	pickFile: vi.fn(),
	describe: vi.fn(),
	exportSelected: vi.fn(),
	zero: { userID: "owner" },
	boundary: {
		waitForSaved: async () => true,
		refreshJournal: () => {},
		getSnapshot: () => ({ pending: 0 }),
	},
	runtime: {} as Record<string, unknown>,
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useState: (initial: unknown) => {
		const index = fixture.state++;
		if (!(index in fixture.states)) fixture.states[index] = initial;
		return [
			fixture.states[index],
			(next: unknown) => {
				fixture.states[index] =
					typeof next === "function" ? next(fixture.states[index]) : next;
			},
		];
	},
	useRef: (initial: unknown) => {
		const index = fixture.ref++;
		if (!(index in fixture.refs)) fixture.refs[index] = { current: initial };
		return fixture.refs[index];
	},
	useCallback: (callback: unknown) => callback,
	useEffect: (effect: () => (() => void) | undefined) => {
		if (!fixture.mounted) fixture.effects.push(effect);
	},
	useId: () => "export",
}));
vi.mock("@rocicorp/zero/react", () => ({
	useZero: () => fixture.zero,
	useQuery: () => [
		[1, 2].map((number) => ({
			id: `attachment-${number}`,
			workspaceId: "workspace",
			state: "committed",
			parentKind: "task",
			parentId: "task",
			keyVersion: 1,
		})),
		{ type: "complete" },
	],
}));
vi.mock("../../../zero/queries.ts", () => ({
	queries: { attachments: { mine: () => ({}) } },
}));
vi.mock("../../lib/e2e/KeyringProvider.tsx", () => ({
	useKeyring: () => ({ ready: true, state: "ready", runtime: fixture.runtime }),
}));
vi.mock("../../lib/zero.tsx", () => ({
	useExportBoundary: () => fixture.boundary,
}));
vi.mock("../../lib/zero-lifecycle.ts", () => ({
	isZeroClientOwnerActive: () => true,
}));
vi.mock("../../lib/e2e/attachment-export-controller.ts", () => ({
	createAttachmentExportController: () => ({
		describe: fixture.describe,
		exportSelected: fixture.exportSelected,
		preflightSelected: () => ({}),
		cancel: () => {},
	}),
}));
vi.mock("../e2e/UnlockDialog.tsx", () => ({ UnlockDialog: () => null }));
vi.mock("../ui/dialog.tsx", () => ({
	Dialog: "dialog",
	DialogContent: "div",
	DialogHeader: "header",
	DialogTitle: "h2",
	DialogDescription: "p",
}));
vi.mock("../ui/button.tsx", () => ({ Button: "button" }));
vi.mock("../ui/input.tsx", () => ({ Input: "input" }));
vi.mock("../ui/checkbox.tsx", () => ({ Checkbox: "input" }));
vi.mock("../../../paraglide/runtime.js", () => ({
	getLocale: () => "en",
	experimentalStaticLocale: undefined,
}));

const pair = {
	content: { filename: "paired-content.json", json: '{"content":true}' },
	files: { filename: "paired-files.json", json: '{"encrypted":true}' },
};
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
function render() {
	fixture.state = fixture.ref = 0;
	const node = AttachmentArchiveExportDialog({ onClose: () => {} });
	if (!fixture.mounted) {
		fixture.mounted = true;
		for (const effect of fixture.effects) {
			const cleanup = effect();
			if (cleanup) fixture.cleanups.push(cleanup);
		}
	}
	return node;
}
function find(
	node: ReactNode,
	match: (props: Record<string, unknown>, type: unknown) => boolean,
): Record<string, unknown> {
	function visit(value: ReactNode): Record<string, unknown> | undefined {
		if (!isValidElement<Record<string, unknown>>(value)) return;
		if (match(value.props, value.type)) return value.props;
		for (const child of Array.isArray(value.props.children)
			? value.props.children
			: [value.props.children]) {
			const found = visit(child as ReactNode);
			if (found) return found;
		}
	}
	const result = visit(node);
	if (!result) throw new Error("Missing export control");
	return result;
}
const text = (node: ReactNode): string => {
	if (typeof node === "string") return node;
	if (!isValidElement<Record<string, ReactNode>>(node)) return "";
	return (
		Array.isArray(node.props.children)
			? node.props.children
			: [node.props.children]
	)
		.map(text)
		.join("");
};
function click(label: string) {
	const button = find(
		render(),
		(props, type) =>
			type === "button" && text(props.children as ReactNode) === label,
	);
	(button.onClick as () => void)();
}
async function prepared() {
	render();
	await nextTurn();
	const checkbox = find(render(), (props) => props.id === "export-file-0");
	(checkbox.onCheckedChange as (value: boolean) => void)(true);
	for (const id of ["export-passphrase", "export-confirm"]) {
		const input = find(render(), (props) => props.id === id);
		(input.onChange as (event: { target: { value: string } }) => void)({
			target: { value: "separate export secret" },
		});
	}
	click("Prepare export");
	await nextTurn();
}
beforeEach(() => {
	Object.assign(fixture, {
		states: [],
		refs: [],
		effects: [],
		cleanups: [],
		mounted: false,
	});
	fixture.describe
		.mockReset()
		.mockImplementation(async (source: { id: string }) => ({
			id: source.id,
			filename: "receipt.txt",
			context: ["Household", "Receipts", "October"],
			createdAt: "2026-10-08T12:00:00.000Z",
			encryptedBytes: 97,
			ordinal: source.id.endsWith("1") ? 1 : 2,
		}));
	fixture.exportSelected.mockReset().mockResolvedValue(pair);
	fixture.pickFile.mockReset().mockResolvedValue({
		createWritable: async () => ({
			write: async () => {},
			close: async () => {},
			abort: async () => {},
		}),
		cancel: async () => {},
	});
	fixture.runtime = {
		attachments: {
			archiveExport: { readContent: async () => "{}" },
			pickFile: fixture.pickFile,
		},
	};
	vi.stubGlobal("document", { body: {}, activeElement: null });
});
afterEach(() => {
	for (const cleanup of fixture.cleanups) cleanup();
	vi.unstubAllGlobals();
});

test("same-parent display collisions get linked context and stable snapshot ordinals", async () => {
	render();
	await nextTurn();
	const html = renderToStaticMarkup(render());
	expect(html.match(/receipt.txt/g)).toHaveLength(2);
	expect(html).toContain("Task: Household / Receipts / October");
	expect(html).toContain("Encrypted size: 97 byte");
	expect(html).toContain("File 1");
	expect(html).toContain("File 2");
	for (const index of [0, 1]) {
		const checkbox = find(
			render(),
			(props) => props.id === `export-file-${index}`,
		);
		expect(checkbox["aria-describedby"]).toBe(`export-source-${index}`);
	}
});
test("different source contexts need no collision ordinal", async () => {
	fixture.describe.mockImplementation(async (source: { id: string }) => ({
		id: source.id,
		filename: "receipt.txt",
		context: [source.id.endsWith("1") ? "Groceries" : "Utilities"],
		createdAt: "2026-10-08T12:00:00.000Z",
		encryptedBytes: 97,
		ordinal: 1,
	}));
	render();
	await nextTurn();
	const html = renderToStaticMarkup(render());
	expect(html).toContain("Groceries");
	expect(html).toContain("Utilities");
	expect(html).not.toContain("File 1");
});
test("cancel and save failure retain the pair and opposite Saved, then retry the exact file", async () => {
	await prepared();
	click("Download app data");
	await nextTurn();
	expect(renderToStaticMarkup(render()).match(/: Saved</g)).toHaveLength(1);
	fixture.pickFile.mockRejectedValueOnce(new FilePickerCancelledError());
	click("Download encrypted attachments");
	await nextTurn();
	let html = renderToStaticMarkup(render());
	expect(html).toContain("Save cancelled.");
	expect(html.replace(/<wbr\/>/g, "")).toContain("paired-content.json");
	expect(html.replace(/<wbr\/>/g, "")).toContain("paired-files.json");
	expect(html.match(/: Saved</g)).toHaveLength(1);
	expect(html).not.toContain("archive could not be prepared");
	fixture.pickFile.mockResolvedValueOnce({
		createWritable: async () => ({
			write: async () => {},
			close: async () => {
				throw new Error("disk failed");
			},
			abort: async () => {},
		}),
		cancel: async () => {},
	});
	click("Download encrypted attachments");
	await nextTurn();
	html = renderToStaticMarkup(render());
	expect(html).toContain('role="alert"');
	expect(html).toContain(
		"Encrypted attachments: This file could not be saved.",
	);
	expect(html.match(/: Saved</g)).toHaveLength(1);
	let finish!: () => void;
	const writes: Uint8Array[] = [];
	fixture.pickFile.mockResolvedValueOnce({
		createWritable: async () => ({
			write: async (bytes: Uint8Array) => {
				writes.push(bytes);
			},
			close: () =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
			abort: async () => {},
		}),
		cancel: async () => {},
	});
	click("Download encrypted attachments");
	click("Download encrypted attachments");
	await nextTurn();
	expect(fixture.pickFile).toHaveBeenCalledTimes(4);
	expect(renderToStaticMarkup(render()).match(/: Saved</g)).toHaveLength(1);
	finish();
	await nextTurn();
	expect(renderToStaticMarkup(render()).match(/: Saved</g)).toHaveLength(2);
	expect(new TextDecoder().decode(writes[0])).toBe(pair.files.json);
	expect(fixture.exportSelected).toHaveBeenCalledOnce();
});

test.each([
	"content",
	"files",
] as const)("latest %s save replaces its own Saved while retaining the other file", async (kind) => {
	await prepared();
	click("Download app data");
	await nextTurn();
	click("Download encrypted attachments");
	await nextTurn();
	const role = kind === "content" ? "App data" : "Encrypted attachments";
	const opposite = kind === "content" ? "Encrypted attachments" : "App data";
	const action =
		kind === "content" ? "Download app data" : "Download encrypted attachments";
	fixture.pickFile.mockRejectedValueOnce(new FilePickerCancelledError());
	click(action);
	await nextTurn();
	let html = renderToStaticMarkup(render());
	expect(html).not.toContain(`${role}: Saved`);
	expect(html).toContain(`${opposite}: Saved`);
	const cancelled = find(
		render(),
		(props) =>
			props.role === "status" &&
			text(props.children as ReactNode).startsWith(`${role}: Save cancelled.`),
	);
	expect(cancelled["aria-atomic"]).toBe("true");
	fixture.pickFile.mockRejectedValueOnce(new Error("destination failed"));
	click(action);
	await nextTurn();
	html = renderToStaticMarkup(render());
	expect(html).not.toContain(`${role}: Saved`);
	expect(html).toContain(`${opposite}: Saved`);
	const failed = find(
		render(),
		(props) =>
			props.role === "alert" &&
			text(props.children as ReactNode).startsWith(
				`${role}: This file could not be saved.`,
			),
	);
	expect(failed["aria-atomic"]).toBe("true");
	click(action);
	await nextTurn();
	const saved = find(
		render(),
		(props) =>
			props.role === "status" &&
			text(props.children as ReactNode) === `${role}: Saved`,
	);
	expect(saved["aria-atomic"]).toBe("true");
	expect(fixture.exportSelected).toHaveBeenCalledOnce();
	expect(
		fixture.pickFile.mock.calls.slice(2).map(([filename]) => filename),
	).toEqual(Array(3).fill(pair[kind].filename));
});

test("selection count follows checkboxes and prepared instructions replace choosing", async () => {
	render();
	await nextTurn();
	expect(renderToStaticMarkup(render())).toContain("0 files selected");
	const first = find(render(), (props) => props.id === "export-file-0");
	(first.onCheckedChange as (checked: boolean) => void)(true);
	expect(renderToStaticMarkup(render())).toContain("1 file selected");
	const second = find(render(), (props) => props.id === "export-file-1");
	(second.onCheckedChange as (checked: boolean) => void)(true);
	expect(renderToStaticMarkup(render())).toContain("2 files selected");
	(first.onCheckedChange as (checked: boolean) => void)(false);
	expect(renderToStaticMarkup(render())).toContain("1 file selected");
	const prepare = find(
		render(),
		(props, type) =>
			type === "button" &&
			text(props.children as ReactNode) === "Prepare export",
	);
	expect(prepare["aria-describedby"]).toContain("export-selected-count");
	for (const id of ["export-passphrase", "export-confirm"]) {
		const input = find(render(), (props) => props.id === id);
		(input.onChange as (event: { target: { value: string } }) => void)({
			target: { value: "separate export secret" },
		});
	}
	click("Prepare export");
	await nextTurn();
	const html = renderToStaticMarkup(render());
	expect(html).toContain("Your export is ready. Save both matching files");
	expect(html).not.toContain("Choose the attachments to export.");
});
