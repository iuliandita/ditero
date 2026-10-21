import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ImportApplyPanel } from "./ImportApplyPanel.tsx";

const fixture = vi.hoisted(() => ({
	cursor: 0,
	slots: [] as unknown[],
	effects: [] as (() => void)[],
	layoutEffects: [] as (() => void)[],
	confirm: vi.fn(async () => true),
	onBusy: vi.fn(),
}));
vi.mock("react", async (original) => {
	const react = await original<typeof import("react")>();
	function effect(
		callback: () => void,
		deps: readonly unknown[],
		layout = false,
	) {
		const index = fixture.cursor++;
		const previous = fixture.slots[index] as readonly unknown[] | undefined;
		fixture.slots[index] = deps;
		if (!previous || deps.some((value, i) => !Object.is(value, previous[i])))
			(layout ? fixture.layoutEffects : fixture.effects).push(callback);
	}
	return {
		...react,
		useId: () => "blocked",
		useRef: (initial: unknown) => {
			const index = fixture.cursor++;
			if (!(index in fixture.slots))
				fixture.slots[index] = { current: initial };
			return fixture.slots[index];
		},
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
		useEffect: (callback: () => void, deps: readonly unknown[]) =>
			effect(callback, deps),
		useLayoutEffect: (callback: () => void, deps: readonly unknown[]) =>
			effect(callback, deps, true),
	};
});
vi.mock("../ui/confirm.tsx", () => ({ useConfirm: () => fixture.confirm }));
vi.mock("../ui/button.tsx", () => ({ Button: "button" }));
vi.mock("./AttachmentArchiveImportDialog.tsx", () => ({
	AttachmentArchiveImportDialog: () => null,
}));
vi.mock("../../../paraglide/messages.js", () => ({
	m: new Proxy({}, { get: (_target, key) => () => String(key) }),
}));
vi.mock("../../../paraglide/runtime.js", () => ({ getLocale: () => "en" }));

const plan = {
	id: "plan",
	planDigest: "digest",
	sourceId: "source",
	documentDigest: "document",
	mappingDigest: "mapping",
	report: {
		plannerVersion: 4 as const,
		applySupported: true,
		counts: { ensure: 1, ignored: 0, blocked: 0 },
	},
};
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
	if (Array.isArray(tree)) return tree.flatMap(nodes);
	if (!isValidElement<Record<string, unknown>>(tree)) return [];
	return [tree, ...nodes(tree.props.children as ReactNode)];
}

test.each([
	["completed", true],
	["completed", false],
	["conflict", true],
	["409", true],
] as const)("%s transfers focus before the dialog trap only when owned: %s", async (state, owned) => {
	const body = {};
	const scope = {};
	const otherInput = {};
	const documentState = {
		body,
		activeElement: body,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	};
	vi.stubGlobal("document", documentState);
	const statusNode = {
		focus: vi.fn(() => {
			documentState.activeElement = statusNode;
		}),
	};
	const actionNode = {};
	let actionMounted = false;
	let respond: (response: Response) => void = () => {
		throw new Error("No apply request");
	};
	const post = new Promise<Response>((resolve) => {
		respond = resolve;
	});
	vi.stubGlobal(
		"fetch",
		vi.fn((_path, options) =>
			options?.method === "POST"
				? post
				: Promise.resolve(Response.json({ run: null })),
		),
	);
	function render() {
		fixture.cursor = 0;
		const tree = ImportApplyPanel({
			plan,
			ownerId: "owner",
			onBusy: fixture.onBusy,
			disabled: false,
		});
		const elements = nodes(tree);
		const status = elements.find(
			(node) => node.props["data-testid"] === "import-apply-status",
		);
		(status?.props.ref as { current: unknown }).current = statusNode;
		const action = elements.find(
			(node) =>
				node.type === "button" &&
				node.props.children !== "archive_import_action",
		);
		if (action) (action.props.ref as { current: unknown }).current = actionNode;
		else if (actionMounted) {
			if (documentState.activeElement === actionNode)
				documentState.activeElement = body;
		}
		actionMounted = Boolean(action);
		for (const callback of fixture.layoutEffects.splice(0)) callback();
		// Radix FocusScope's mutation observer focuses the container if a removed
		// descendant left focus on body, before React's passive effects run.
		if (!actionMounted && documentState.activeElement === body)
			documentState.activeElement = scope;
		for (const callback of fixture.effects.splice(0)) callback();
		return action;
	}
	render();
	await nextTurn();
	const apply = render();
	if (!apply) throw new Error("Missing apply action");
	(apply.props.onClick as () => void)();
	await nextTurn();
	render();
	documentState.activeElement = owned ? actionNode : otherInput;
	respond(
		state === "409"
			? new Response(null, { status: 409 })
			: Response.json({
					jobId: "plan",
					state,
					nextOrdinal: 1,
					appliedCount: 1,
					noopCount: 0,
					conflictCode: null,
					conflictOrdinal: null,
				}),
	);
	await nextTurn();
	render();
	expect(documentState.activeElement).toBe(owned ? statusNode : otherInput);
	expect(statusNode.focus).toHaveBeenCalledTimes(owned ? 1 : 0);
	documentState.activeElement = otherInput;
	render();
	expect(documentState.activeElement).toBe(otherInput);
});

beforeEach(() => {
	fixture.cursor = 0;
	fixture.slots = [];
	fixture.effects = [];
	fixture.layoutEffects = [];
	vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

test.each([
	["completed", "action"],
	["conflict", "action"],
	["completed", "elsewhere"],
	["conflict", "elsewhere"],
	["completed", "body-after-move"],
	["conflict", "body-after-move"],
	["completed", "elsewhere-at-commit"],
	["conflict", "elsewhere-at-commit"],
] as const)("status retry %s preserves focus at %s", async (state, destination) => {
	const body = {};
	const otherInput = {};
	const listeners = new Set<() => void>();
	const documentState = {
		body,
		activeElement: body,
		addEventListener: (_event: string, callback: () => void) =>
			listeners.add(callback),
		removeEventListener: (_event: string, callback: () => void) =>
			listeners.delete(callback),
	};
	vi.stubGlobal("document", documentState);
	const statusNode = {
		focus: vi.fn(() => {
			documentState.activeElement = statusNode;
		}),
	};
	const actionNode = {};
	let respond!: (response: Response) => void;
	const pending = new Promise<Response>((resolve) => {
		respond = resolve;
	});
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 500 }))
			.mockReturnValueOnce(pending),
	);
	function render() {
		fixture.cursor = 0;
		const tree = ImportApplyPanel({
			plan,
			ownerId: "owner",
			onBusy: fixture.onBusy,
			disabled: false,
		});
		const elements = nodes(tree);
		const status = elements.find(
			(node) => node.props["data-testid"] === "import-apply-status",
		);
		(status?.props.ref as { current: unknown }).current = statusNode;
		const action = elements.find(
			(node) =>
				node.type === "button" &&
				node.props.children !== "archive_import_action",
		);
		if (action) (action.props.ref as { current: unknown }).current = actionNode;
		else {
			const ref = fixture.slots.find(
				(slot) => (slot as { current?: unknown })?.current === actionNode,
			) as { current: unknown };
			ref.current = null;
			if (documentState.activeElement === actionNode)
				documentState.activeElement = body;
		}
		for (const callback of fixture.layoutEffects.splice(0)) callback();
		for (const callback of fixture.effects.splice(0)) callback();
		return action;
	}
	render();
	await nextTurn();
	const retry = render();
	if (!retry) throw new Error("Missing status retry action");
	expect(retry.props.children).toBe("import_apply_retry_status");
	documentState.activeElement = actionNode;
	(retry.props.onClick as () => void)();
	render();
	if (destination !== "action" && destination !== "elsewhere-at-commit") {
		documentState.activeElement = otherInput;
		for (const callback of listeners) callback();
		if (destination === "body-after-move") documentState.activeElement = body;
	}
	respond(
		Response.json({
			run: {
				jobId: "plan",
				state,
				nextOrdinal: 1,
				appliedCount: 1,
				noopCount: 0,
				conflictCode: null,
				conflictOrdinal: null,
			},
		}),
	);
	await nextTurn();
	if (destination === "elsewhere-at-commit")
		documentState.activeElement = otherInput;
	render();
	expect(statusNode.focus).toHaveBeenCalledTimes(
		destination === "action" ? 1 : 0,
	);
	expect(documentState.activeElement).toBe(
		destination === "action"
			? statusNode
			: destination === "elsewhere" || destination === "elsewhere-at-commit"
				? otherInput
				: body,
	);
});
