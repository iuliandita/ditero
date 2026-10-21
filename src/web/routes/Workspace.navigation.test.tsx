import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Workspace } from "./Workspace.tsx";

const fixture = vi.hoisted(() => ({
	cursor: 0,
	slots: [] as unknown[],
	effects: [] as (() => void)[],
	layoutEffects: [] as (() => void)[],
	dirty: false,
	desktop: true,
	ready: false,
	paletteOpen: false,
	homeViewRef: null as string | null,
	savedNavigation: {
		workspaceId: "saved-workspace",
		listId: "saved-list" as string | null,
	},
	workspaces: [{ id: "personal", kind: "personal", name: "Personal" }],
	lists: [{ id: "other-list", workspaceId: "personal", kind: "tasks" }],
	save: vi.fn(),
}));

// Exercise the component's real handlers and effects across delayed row arrivals.
// Child surfaces remain at their boundaries; state and refs survive each render.
vi.mock("react", async (original) => {
	const react = await original<typeof import("react")>();
	function useState(initial: unknown): [unknown, (next: unknown) => void] {
		const index = fixture.cursor++;
		if (!(index in fixture.slots))
			fixture.slots[index] =
				typeof initial === "function" ? initial() : initial;
		return [
			fixture.slots[index],
			(next: unknown) => {
				const value =
					typeof next === "function" ? next(fixture.slots[index]) : next;
				if (!Object.is(value, fixture.slots[index])) fixture.dirty = true;
				fixture.slots[index] = value;
			},
		];
	}
	function changed(deps: readonly unknown[] | undefined) {
		const index = fixture.cursor++;
		const previous = fixture.slots[index] as readonly unknown[] | undefined;
		fixture.slots[index] = deps;
		return (
			!deps ||
			!previous ||
			deps.some((value, i) => !Object.is(value, previous[i]))
		);
	}
	function useMemo(read: () => unknown, deps: readonly unknown[]) {
		const recalculate = changed(deps);
		const index = fixture.cursor++;
		if (recalculate) fixture.slots[index] = read();
		return fixture.slots[index];
	}
	return {
		...react,
		useState,
		useReducer: (
			reducer: (state: unknown, action: unknown) => unknown,
			initial: unknown,
		) => {
			const [state, setState] = useState(initial);
			return [
				state,
				(action: unknown) =>
					setState((previous: unknown) => reducer(previous, action)),
			];
		},
		useRef: (initial: unknown) => {
			const index = fixture.cursor++;
			if (!(index in fixture.slots))
				fixture.slots[index] = { current: initial };
			return fixture.slots[index];
		},
		useMemo,
		useCallback: (callback: unknown, deps: readonly unknown[]) =>
			useMemo(() => callback, deps),
		useEffect: (effect: () => void, deps: readonly unknown[] | undefined) => {
			if (changed(deps)) fixture.effects.push(effect);
		},
		useLayoutEffect: (
			effect: () => void,
			deps: readonly unknown[] | undefined,
		) => {
			if (changed(deps)) fixture.layoutEffects.push(effect);
		},
	};
});
vi.mock("@rocicorp/zero/react", () => ({
	useZero: () => ({ userID: "user" }),
	useQuery: () => [[], { type: "complete" }],
}));
vi.mock("../lib/last-navigation.ts", () => ({
	loadLastNavigation: () => fixture.savedNavigation,
	saveLastNavigation: fixture.save,
}));
vi.mock("../lib/native-account.tsx", () => ({
	useAccountStorageScope: () => "user",
	useNativeAccount: () => null,
}));
vi.mock("../lib/use-media-query.ts", () => ({
	useIsDesktop: () => fixture.desktop,
	useMediaQuery: () => true,
}));
vi.mock("../hooks/useWorkspaceData.ts", () => ({
	useWorkspaceData: () => ({
		workspaces: fixture.workspaces,
		lists: fixture.lists,
		folders: [],
		templates: [],
		tasks: [{ id: "task", listId: "other-list" }],
		labels: [],
		taskLabels: [],
		assignees: [],
		memberships: [],
		viewRowsLoading: !fixture.ready,
		navigationRowsReady: fixture.ready,
		notificationRowsReady: fixture.ready,
		roleByWorkspace: new Map([["personal", "owner"]]),
		shareable: [],
		members: [],
		membershipWorkspaceIds: ["personal"],
		labelIdsByTask: new Map(),
	}),
}));
vi.mock("../hooks/useSyncedTheme.ts", () => ({ useSyncedTheme: () => {} }));
vi.mock("../hooks/useAccountSetup.ts", () => ({ useAccountSetup: () => ({}) }));
vi.mock("../hooks/useTaskImportActivation.ts", () => ({
	useTaskImportActivationMap: () => ({ canWriteTask: () => true }),
}));
vi.mock("../hooks/useViews.ts", () => ({ useViews: () => ({ views: [] }) }));
vi.mock("../hooks/useDashboards.ts", () => ({
	useDashboards: () => ({
		dashboards: [{ id: "dashboard" }],
		loading: !fixture.ready,
	}),
}));
vi.mock("../hooks/useUserPref.ts", () => ({
	useUserPref: () => ({
		pref: { homeViewRef: fixture.homeViewRef },
		setPref: () => {},
		loading: !fixture.ready,
	}),
}));
vi.mock("../hooks/useHints.ts", () => ({
	useHints: () => ({ hints: "off", shortcutsSeen: () => {} }),
}));
vi.mock("../keyboard/useEffectiveKeymap.ts", () => ({
	useEffectiveKeymap: () => ({}),
}));
vi.mock("../keyboard/CommandContext.tsx", () => ({
	CommandProvider: "commands",
	useCommands: () => ({ isOpen: fixture.paletteOpen }),
}));
vi.mock("../lib/nav-sections.ts", () => ({
	useNavSections: () => ({ isOpen: () => true, toggle: () => {} }),
}));
vi.mock("../hooks/useNativeTaskLinks.ts", () => ({
	useNativeTaskLinks: () => {},
}));
vi.mock("../hooks/useNativeNotificationNavigation.ts", () => ({
	useNativeNotificationNavigation: () => {},
}));
vi.mock("../hooks/useWorkspaceViews.ts", () => ({
	useWorkspaceViews: () => ({
		pinnedViews: [],
		resolveView: (id: string) => ({
			id,
			name: id,
			display: { layout: "list" },
		}),
		isPinned: () => false,
	}),
}));
vi.mock("../hooks/useWorkspaceDashboards.ts", () => ({
	useWorkspaceDashboards: () => ({}),
}));
vi.mock("../hooks/useWorkspaceRowActions.ts", () => ({
	useWorkspaceRowActions: () => ({}),
}));
vi.mock("../../paraglide/messages.js", () => ({
	m: new Proxy({}, { get: (_target, key) => () => String(key) }),
}));
vi.mock("../../paraglide/runtime.js", () => ({ getLocale: () => "en" }));
vi.mock("../lib/nav-icon.tsx", () => ({ viewIcon: () => null }));

function find(
	node: ReactNode,
	name: string,
): ReactElement<Record<string, unknown>> {
	const queue = [node];
	while (queue.length) {
		const next = queue.shift();
		if (!isValidElement<Record<string, unknown>>(next)) continue;
		const type = next.type;
		if (type === name || (typeof type === "function" && type.name === name))
			return next;
		for (const prop of [
			"children",
			"sidebar",
			"bottomNav",
			"fab",
			"firstRun",
			"setupPanel",
		])
			queue.push(next.props[prop] as ReactNode);
		if (Array.isArray(next.props.children)) queue.push(...next.props.children);
	}
	throw new Error(`Missing component: ${name}`);
}

function render(initialSetup = false): ReactNode {
	let tree: ReactNode;
	for (let pass = 0; pass < 10; pass++) {
		fixture.cursor = 0;
		fixture.dirty = false;
		fixture.effects = [];
		fixture.layoutEffects = [];
		const normal = Workspace({ initialSetup });
		tree = (normal.type as (props: typeof normal.props) => ReactNode)(
			normal.props,
		);
		// Palette open state belongs to the child provider. Run its observer too.
		try {
			const observer = find(tree, "PaletteNavigation");
			(observer.type as (props: typeof observer.props) => ReactNode)(
				observer.props,
			);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.startsWith("Missing component:")
			)
				throw error;
		}
		for (const effect of fixture.layoutEffects) effect();
		for (const effect of fixture.effects) effect();
		if (!fixture.dirty) return tree;
	}
	throw new Error("Workspace effects did not settle");
}

function act(
	tree: ReactNode,
	component: string,
	handler: string,
	...args: unknown[]
) {
	const callback = find(tree, component).props[handler];
	if (typeof callback !== "function")
		throw new Error(`Missing handler: ${handler}`);
	callback(...args);
	return render();
}
function syncSavedRows() {
	fixture.workspaces = [
		...fixture.workspaces,
		{ id: "saved-workspace", kind: "shared", name: "Saved" },
	];
	fixture.lists = [
		...fixture.lists,
		{ id: "saved-list", workspaceId: "saved-workspace", kind: "tasks" },
	];
	fixture.ready = true;
	return render();
}
function expectSurface(
	tree: ReactNode,
	name: string,
	idProp?: string,
	id?: string,
) {
	const surface = find(tree, name);
	if (idProp) expect(surface.props[idProp]).toBe(id);
	expect(find(tree, "WorkspaceOverlays").props.openListId).not.toBe(
		"saved-list",
	);
	if (fixture.ready)
		expect(find(tree, "WorkspaceOverlays").props.activeId).toBe("personal");
}

beforeEach(() => {
	fixture.cursor = 0;
	fixture.slots = [];
	fixture.effects = [];
	fixture.desktop = true;
	fixture.ready = false;
	fixture.paletteOpen = false;
	fixture.homeViewRef = null;
	fixture.savedNavigation = {
		workspaceId: "saved-workspace",
		listId: "saved-list",
	};
	fixture.workspaces = [{ id: "personal", kind: "personal", name: "Personal" }];
	fixture.lists = [
		{ id: "other-list", workspaceId: "personal", kind: "tasks" },
	];
	fixture.save.mockClear();
	vi.stubGlobal("window", { location: { pathname: "/" } });
});
afterEach(() => vi.unstubAllGlobals());

test.each([
	["onOpenSettings", [], "SettingsSurface", undefined, undefined],
	["onOpenAppearance", [], "SettingsSurface", "initialSection", "appearance"],
	["onOpenView", ["view"], "ViewRenderer", undefined, undefined],
	["onOpenDashboard", ["dashboard"], "DashboardView", undefined, undefined],
	["onOpenList", ["other-list"], "ListView", "listId", "other-list"],
	["onSelectWorkspace", ["personal"], "ViewRenderer", undefined, undefined],
	["onOpenView", ["today"], "ViewRenderer", undefined, undefined],
	["onNewList", [], "CreateList", undefined, undefined],
] as const)("%s cancels a delayed saved selection", (handler, args, surface, idProp, id) => {
	let tree = render();
	expect(find(tree, "WorkspaceOverlays").props.openListId).toBeNull();
	tree = act(tree, "Sidebar", handler, ...args);
	expectSurface(tree, surface, idProp, id);
	tree = syncSavedRows();
	expectSurface(tree, surface, idProp, id);
});

test.each([
	"search",
	"task",
	"palette",
	"mobile-index",
])("%s navigation survives delayed saved rows", (target) => {
	if (target === "search" || target === "mobile-index") fixture.desktop = false;
	let tree = render();
	if (target === "search") tree = act(tree, "BottomNav", "onSearch");
	if (target === "task")
		tree = act(tree, "ViewRenderer", "onOpenTask", { id: "task" });
	if (target === "palette") {
		fixture.paletteOpen = true;
		tree = render();
	}
	if (target === "mobile-index")
		tree = act(tree, "BottomNav", "onTab", "lists");
	tree = syncSavedRows();
	expectSurface(
		tree,
		target === "mobile-index" ? "MobileListIndex" : "WorkspaceOverlays",
	);
	if (target === "search")
		expect(find(tree, "WorkspaceOverlays").props.searchOpen).toBe(true);
	if (target === "task")
		expect(find(tree, "WorkspaceOverlays").props.detailTask).toMatchObject({
			id: "task",
		});
});

test("saved rows still restore when the user has not navigated", () => {
	render();
	const tree = syncSavedRows();
	expect(find(tree, "ListView").props.listId).toBe("saved-list");
	expect(find(tree, "WorkspaceOverlays").props.activeId).toBe(
		"saved-workspace",
	);
});

test("explicit home navigation also cancels a pending preferred dashboard", () => {
	fixture.homeViewRef = "dashboard:dashboard";
	const tree = act(render(), "Sidebar", "onNewList");
	expectSurface(tree, "CreateList");
	expectSurface(syncSavedRows(), "CreateList");
});

test("setup remains open while the saved workspace initializes", () => {
	render(true);
	fixture.ready = true;
	fixture.workspaces.push({
		id: "saved-workspace",
		kind: "shared",
		name: "Saved",
	});
	fixture.lists.push({
		id: "saved-list",
		workspaceId: "saved-workspace",
		kind: "tasks",
	});
	const tree = render(true);
	expect(find(tree, "SettingsSurface").props.activeId).toBe("saved-workspace");
	expect(find(tree, "WorkspaceOverlays").props.openListId).toBeNull();
});

test.each([
	["onNewView", "viewManager"],
	["onNewDashboard", "dashboardManager"],
	["onManageMembers", "membersOpen"],
	["onCreateWorkspace", "createWorkspaceOpen"],
])("%s keeps its form context when saved rows arrive", (handler, prop) => {
	act(render(), "Sidebar", handler);
	const tree = syncSavedRows();
	expectSurface(tree, "ViewRenderer");
	expect(find(tree, "WorkspaceOverlays").props[prop]).toBeTruthy();
});

test("palette opening in the same commit as saved rows cancels restoration", () => {
	render();
	fixture.paletteOpen = true;
	expectSurface(syncSavedRows(), "ViewRenderer");
});

test("Settings remains open when no workspace rows existed at navigation time", () => {
	fixture.workspaces = [];
	act(render(), "Sidebar", "onOpenSettings");
	fixture.workspaces = [{ id: "personal", kind: "personal", name: "Personal" }];
	expectSurface(syncSavedRows(), "SettingsSurface");
});

test.each([
	false,
	true,
])("preferred dashboard respects concurrent palette navigation: %s", (openPalette) => {
	fixture.savedNavigation = { workspaceId: "personal", listId: null };
	fixture.homeViewRef = "dashboard:dashboard";
	render();
	fixture.paletteOpen = openPalette;
	fixture.ready = true;
	const tree = render();
	if (openPalette) expectSurface(tree, "ViewRenderer");
	else
		expect(find(tree, "DashboardView").props.dashboard).toMatchObject({
			id: "dashboard",
		});
});
