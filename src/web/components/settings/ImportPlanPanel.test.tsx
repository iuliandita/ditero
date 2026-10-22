import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ImportPlanPanel } from "./ImportPlanPanel.tsx";

const fixture = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[] }));
vi.mock("react", async (original) => {
	const react = await original<typeof import("react")>();
	return {
		...react,
		useId: () => "id",
		useRef: (initial: unknown) => {
			const index = fixture.cursor++;
			if (!(index in fixture.slots))
				fixture.slots[index] = { current: initial };
			return fixture.slots[index];
		},
		useState: (initial: unknown) => {
			const index = fixture.cursor++;
			if (!(index in fixture.slots))
				fixture.slots[index] =
					typeof initial === "function"
						? (initial as () => unknown)()
						: initial;
			return [
				fixture.slots[index],
				(next: unknown) => {
					fixture.slots[index] =
						typeof next === "function" ? next(fixture.slots[index]) : next;
				},
			];
		},
		useCallback: (callback: unknown) => callback,
		useEffect: () => undefined,
	};
});
const zero = vi.hoisted(() => ({ userID: "user" }));
vi.mock("@rocicorp/zero/react", () => ({
	useQuery: () => [[]],
	useZero: () => zero,
}));
vi.mock("../../../zero/queries.ts", () => ({
	queries: new Proxy(
		{},
		{ get: () => new Proxy({}, { get: () => () => null }) },
	),
}));
vi.mock("../../lib/zero-lifecycle.ts", () => ({
	isZeroClientOwnerActive: () => true,
}));
vi.mock("../ui/button.tsx", () => ({ Button: "button" }));
vi.mock("../ui/confirm.tsx", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../ui/file-picker.tsx", () => ({ FilePicker: "file-picker" }));
vi.mock("../ui/input.tsx", () => ({ Input: "input" }));
vi.mock("../ui/select.tsx", () => ({
	Select: "select-root",
	SelectContent: "select-content",
	SelectItem: "select-item",
	SelectTrigger: "select-trigger",
	SelectValue: "select-value",
}));
vi.mock("./ImportApplyPanel.tsx", () => ({ ImportApplyPanel: () => null }));
vi.mock("../../../paraglide/messages.js", () => ({
	m: new Proxy(
		{},
		{
			get: (_target, key) => (args?: unknown) =>
				args ? `${String(key)} ${JSON.stringify(args)}` : String(key),
		},
	),
}));
vi.mock("../../../paraglide/runtime.js", () => ({ getLocale: () => "en" }));

type Props = Record<string, unknown>;
type Node = ReactElement<Props>;
class FakeWorker {
	static all: FakeWorker[] = [];
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	terminated = false;
	posted: Props[] = [];
	constructor() {
		FakeWorker.all.push(this);
	}
	postMessage(message: Props) {
		this.posted.push(message);
	}
	terminate() {
		this.terminated = true;
	}
	reply(data: unknown) {
		this.onmessage?.({ data });
	}
}

const conversion = (timezone: string) => ({
	input: {
		adapter: "provider-content",
		provider: "ticktick",
		timezone,
		sourceNamespace: "namespace",
		unsectionedListName: "Inbox",
		snapshotSha256: "digest",
		notices: [],
	},
	document: {
		sourceUserId: "source",
		data: { workspaces: [], principals: [], labels: [] },
	},
});

function nodes(tree: ReactNode): Node[] {
	if (Array.isArray(tree)) return tree.flatMap(nodes);
	if (!isValidElement<Props>(tree)) return [];
	if (typeof tree.type === "function")
		return nodes((tree.type as (props: Props) => ReactNode)(tree.props));
	const children = tree.props.children;
	return [
		tree,
		...nodes(
			typeof children === "function"
				? (children as (id: string) => ReactNode)("id")
				: (children as ReactNode),
		),
	];
}
function render(): Node[] {
	fixture.cursor = 0;
	return nodes(ImportPlanPanel());
}
const byTestId = (tree: Node[], id: string) =>
	tree.find((node) => node.props["data-testid"] === id);
const call = (node: Node | undefined, prop: string, ...args: unknown[]) => {
	const handler = node?.props[prop];
	if (typeof handler !== "function") throw new Error(`Missing ${prop}`);
	handler(...args);
};
const saveButton = (tree: Node[]) =>
	tree.find((node) => node.type === "button" && !node.props.variant);
const alertText = (tree: Node[]) =>
	tree.find((node) => node.props.role === "alert" && node.type === "p")?.props
		.children;

const zoneInput = (tree: Node[]) => byTestId(tree, "import-content-timezone");
const picked = { name: "tasks.csv", size: 10 };

// Selects TickTick and picks a file, leaving its worker pending.
function pickFile(): FakeWorker {
	call(
		render().find(
			(node) => node.type === "select-root" && node.props.value === "native",
		),
		"onValueChange",
		"ticktick",
	);
	call(
		render().find((node) => node.type === "file-picker"),
		"onFile",
		picked,
	);
	return FakeWorker.all.at(-1) as FakeWorker;
}

// A loaded UTC conversion with a source label and the policy accepted.
function ready(): FakeWorker {
	const worker = pickFile();
	worker.reply(conversion("UTC"));
	call(
		render().find((node) => node.type === "input" && node.props.id === "id"),
		"onChange",
		{ target: { value: "Source" } },
	);
	call(byTestId(render(), "import-provider-policy"), "onChange", {
		target: { checked: true },
	});
	expect(saveButton(render())?.props.disabled).toBe(false);
	return worker;
}

beforeEach(() => {
	fixture.cursor = 0;
	fixture.slots = [];
	FakeWorker.all = [];
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("editing the zone drops the loaded conversion at once and reparses with the new zone", () => {
	ready();
	const workers = FakeWorker.all.length;
	call(zoneInput(render()), "onChange", { target: { value: "Europe/Berlin" } });
	const tree = render();
	expect(saveButton(tree)?.props.disabled).toBe(true);
	expect(byTestId(tree, "import-provider-policy")).toBeUndefined();
	expect(FakeWorker.all).toHaveLength(workers);
	vi.advanceTimersByTime(500);
	expect(FakeWorker.all.at(-1)?.posted[0]?.timezone).toBe("Europe/Berlin");
});

test("an invalid zone leaves Save disabled and is never reparsed", () => {
	ready();
	const workers = FakeWorker.all.length;
	call(zoneInput(render()), "onChange", { target: { value: "Bad/Zone" } });
	vi.advanceTimersByTime(5_000);
	const tree = render();
	expect(saveButton(tree)?.props.disabled).toBe(true);
	expect(byTestId(tree, "import-provider-policy")).toBeUndefined();
	expect(FakeWorker.all).toHaveLength(workers);
});

test("a result for the previous zone that arrives after an edit is discarded", () => {
	const stale = pickFile();
	call(zoneInput(render()), "onChange", { target: { value: "Europe/Berlin" } });
	expect(stale.terminated).toBe(true);
	stale.reply(conversion("UTC"));
	const tree = render();
	expect(byTestId(tree, "import-provider-policy")).toBeUndefined();
	expect(saveButton(tree)?.props.disabled).toBe(true);
});

test.each([
	["limit", "field-limit", "import_content_limits", 7],
	["invalid", "invalid-row", "import_content_invalid", 9],
] as const)("a %s failure with a known row shows that row", (error, code, message, row) => {
	pickFile().reply({ error, code, row });
	const text = String(alertText(render()));
	expect(text).toContain(message);
	expect(text).toContain(`import_content_err_at_row {"row":"${row}"}`);
});
