import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Task } from "../../../zero/schema.gen.ts";
import { CommentThread } from "./CommentThread.tsx";

const fixture = vi.hoisted(() => ({
	cursor: 0,
	slots: [] as unknown[],
	runtime: {} as {
		fetcher?: typeof fetch;
		attachments?: { fetcher: typeof fetch };
	},
	key: { keyVersion: 1, wdk: new Uint8Array(32) },
	mutate: vi.fn(),
	upload: vi.fn(),
	reportUploadFailure: vi.fn(),
	runWithFiles: vi.fn(),
}));

// Drive the component's event handlers without adding a DOM test dependency.
// State and refs persist across renders; child components stay at their boundaries.
vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useState: (initial: unknown) => {
		const index = fixture.cursor++;
		if (!(index in fixture.slots)) fixture.slots[index] = initial;
		return [
			fixture.slots[index],
			(next: unknown) => {
				fixture.slots[index] =
					typeof next === "function" ? next(fixture.slots[index]) : next;
			},
		];
	},
	useRef: (initial: unknown) => {
		const index = fixture.cursor++;
		if (!(index in fixture.slots)) fixture.slots[index] = { current: initial };
		return fixture.slots[index];
	},
	useMemo: (factory: () => unknown) => factory(),
	useId: () => "composer-status",
	useLayoutEffect: () => {},
}));
vi.mock("@rocicorp/zero/react", () => ({
	useZero: () => ({ userID: "user-1", mutate: fixture.mutate }),
	useQuery: () => [[], { type: "complete" }],
}));
vi.mock("../../../zero/queries.ts", () => ({
	queries: new Proxy({}, { get: () => ({ mine: () => ({}) }) }),
}));
vi.mock("../../../zero/mutators.ts", () => ({
	mutators: { comment: { add: (input: unknown) => input } },
}));
vi.mock("../../../paraglide/messages.js", () => ({
	m: new Proxy({}, { get: (_target, key) => () => String(key) }),
}));
vi.mock("../../../paraglide/runtime.js", () => ({ getLocale: () => "en" }));
vi.mock("../../lib/e2e/KeyringProvider.tsx", () => ({
	useKeyring: () => ({ runtime: fixture.runtime }),
}));
vi.mock("../../lib/e2e/upload.ts", () => ({
	uploadAttachment: fixture.upload,
}));
vi.mock("../attachments/states.tsx", () => ({
	useAttachmentGate: () => ({
		runWithFiles: fixture.runWithFiles,
		hasPendingAction: () => false,
		reportUploadFailure: fixture.reportUploadFailure,
	}),
}));
vi.mock("../attachments/AttachmentDropzone.tsx", () => ({
	AttachmentDropzone: "dropzone",
}));
vi.mock("../attachments/AttachmentList.tsx", () => ({
	AttachmentList: "attachment-list",
}));
vi.mock("../attachments/AttachmentTile.tsx", () => ({
	PendingAttachmentTile: "pending-file",
}));
vi.mock("@/components/ui/button", () => ({ Button: "button" }));
vi.mock("@/components/ui/input", () => ({ Input: "input" }));

function render() {
	fixture.cursor = 0;
	return CommentThread({
		task: { id: "task-1" } as Task,
		workspaceId: "workspace-1",
	});
}

function find(
	node: ReactNode,
	match: (props: Record<string, unknown>, type: unknown) => boolean,
): Record<string, unknown> {
	function visit(node: ReactNode): Record<string, unknown> | undefined {
		if (!isValidElement<Record<string, unknown>>(node)) return;
		if (match(node.props, node.type)) return node.props;
		const children = node.props.children;
		for (const child of Array.isArray(children) ? children : [children]) {
			const found = visit(child as ReactNode);
			if (found) return found;
		}
	}
	const found = visit(node);
	if (!found) throw new Error("Component control not found");
	return found;
}

function selectFile() {
	const dropzone = find(render(), (_props, type) => type === "dropzone");
	(dropzone.onFilesReady as (files: File[]) => void)([
		new File(["public fixture"], "upload.txt", { type: "text/plain" }),
	]);
}

async function send() {
	const button = find(
		render(),
		(props) => props["data-testid"] === "comment-submit",
	);
	expect(button.disabled).toBe(false);
	(button.onClick as () => void)();
	await fixture.runWithFiles.mock.results.at(-1)?.value;
}

beforeEach(() => {
	fixture.cursor = 0;
	fixture.slots = [];
	fixture.runtime = {};
	fixture.mutate.mockReset().mockImplementation(() => ({
		client: Promise.resolve(),
		server: Promise.resolve({ type: "success" }),
	}));
	fixture.upload.mockReset().mockResolvedValue({ id: "attachment-1" });
	fixture.reportUploadFailure.mockReset();
	fixture.runWithFiles
		.mockReset()
		.mockImplementation(async (_files, action) => action(fixture.key));
	vi.stubGlobal("document", { activeElement: null, body: {} });
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

test.each([
	"native",
	"browser",
] as const)("%s comment Send selects the attachment transport after creating its parent", async (platform) => {
	const nativeFetcher = vi.fn<typeof fetch>();
	// Browser runtimes also have a general fetcher; it must not force stream upload.
	const generalFetcher = vi.fn<typeof fetch>();
	fixture.runtime = {
		fetcher: generalFetcher,
		...(platform === "native"
			? { attachments: { fetcher: nativeFetcher } }
			: {}),
	};
	let acknowledge!: (result: { type: string }) => void;
	const server = new Promise<{ type: string }>((resolve) => {
		acknowledge = resolve;
	});
	fixture.mutate.mockImplementation(() => ({
		client: Promise.resolve(),
		server,
	}));
	selectFile();
	const sending = send();
	expect(fixture.mutate).toHaveBeenCalledOnce();
	expect(fixture.upload).not.toHaveBeenCalled();
	acknowledge({ type: "success" });
	await sending;
	expect(fixture.mutate).toHaveBeenCalledOnce();
	expect(fixture.upload).toHaveBeenCalledOnce();
	const comment = fixture.mutate.mock.calls[0]?.[0];
	expect(fixture.upload.mock.calls[0]?.[0]).toMatchObject({
		workspaceId: "workspace-1",
		parentKind: "comment",
		parentId: comment.id,
	});
	expect(fixture.upload.mock.calls[0]?.[1].fetcher).toBe(
		platform === "native" ? nativeFetcher : undefined,
	);
	expect(fixture.upload.mock.calls[0]?.[1].fetcher).not.toBe(generalFetcher);
	expect(fixture.mutate.mock.invocationCallOrder[0]).toBeLessThan(
		fixture.upload.mock.invocationCallOrder[0] ?? 0,
	);
});

test("retry keeps the native attachment transport and reuses the created comment", async () => {
	const nativeFetcher = vi.fn<typeof fetch>();
	fixture.runtime = { attachments: { fetcher: nativeFetcher } };
	const failure = new Error("Upload failed");
	fixture.upload.mockRejectedValueOnce(failure);
	vi.spyOn(console, "error").mockImplementation(() => {});
	selectFile();
	await send();
	expect(fixture.reportUploadFailure).toHaveBeenCalledWith(failure);
	const pending = find(render(), (_props, type) => type === "pending-file");
	expect(pending.error).toBe("attachment_error_upload_failed");
	await send();
	expect(fixture.mutate).toHaveBeenCalledOnce();
	expect(fixture.upload).toHaveBeenCalledTimes(2);
	for (const [input, options] of fixture.upload.mock.calls) {
		expect(input.parentId).toBe(fixture.mutate.mock.calls[0]?.[0].id);
		expect(options.fetcher).toBe(nativeFetcher);
	}
});
