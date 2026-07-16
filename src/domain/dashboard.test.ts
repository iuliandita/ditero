import { describe, expect, test } from "vitest";
import {
	MAX_PANELS,
	PANEL_SPANS,
	type Panel,
	type PanelSource,
	panelSchema,
	panelsSchema,
	resolvePanelSource,
} from "./dashboard.ts";
import type { FilterGroup, ViewDisplay } from "./view-filter.ts";

const emptyFilter: FilterGroup = { op: "and", conditions: [] };
const inlineSource: PanelSource = {
	kind: "inline",
	filter: emptyFilter,
	sort: { field: "sortKey", dir: "asc" },
	workspaceScope: { mode: "all" },
};

const tasksPanel: Panel = {
	id: "p1",
	type: "tasks",
	source: inlineSource,
	size: "m",
	title: "My tasks",
	limit: 10,
};
const counterPanel: Panel = {
	id: "p2",
	type: "counter",
	source: { kind: "view", viewId: "v1" },
	size: "s",
};
const streakPanel: Panel = {
	id: "p3",
	type: "streak",
	habitIds: ["h1", "h2"],
	size: "l",
};
const focusPanel: Panel = {
	id: "p4",
	type: "focus",
	range: "week",
	size: "full",
};

describe("PANEL_SPANS", () => {
	test("grid spans per size", () => {
		expect(PANEL_SPANS).toEqual({ s: 3, m: 6, l: 8, full: 12 });
	});
});

describe("panelSchema", () => {
	test("all four panel types parse", () => {
		for (const panel of [tasksPanel, counterPanel, streakPanel, focusPanel]) {
			expect(() => panelSchema.parse(panel)).not.toThrow();
		}
	});

	test("unknown key on the panel is rejected", () => {
		expect(() => panelSchema.parse({ ...focusPanel, bogus: 1 })).toThrow();
	});

	test("unknown key inside the source is rejected", () => {
		expect(() =>
			panelSchema.parse({
				...tasksPanel,
				source: { ...inlineSource, bogus: 1 },
			}),
		).toThrow();
		expect(() =>
			panelSchema.parse({
				...counterPanel,
				source: { kind: "view", viewId: "v1", bogus: 1 },
			}),
		).toThrow();
	});

	test("unknown key inside workspaceScope is rejected", () => {
		expect(() =>
			panelSchema.parse({
				...tasksPanel,
				source: {
					...inlineSource,
					workspaceScope: { mode: "all", bogus: 1 },
				},
			}),
		).toThrow();
	});

	test("unknown key inside sort is rejected", () => {
		expect(() =>
			panelSchema.parse({
				...tasksPanel,
				source: {
					...inlineSource,
					sort: { field: "sortKey", dir: "asc", bogus: 1 },
				},
			}),
		).toThrow();
	});

	test("over-deep inline filter is rejected", () => {
		let node: unknown = { op: "and", conditions: [] };
		for (let i = 0; i < 6; i++) node = { op: "and", conditions: [node] };
		expect(() =>
			panelSchema.parse({
				...tasksPanel,
				source: { ...inlineSource, filter: node },
			}),
		).toThrow(/deep/i);
	});

	test("limit 0 / 51 / non-int rejected", () => {
		for (const limit of [0, 51, 1.5]) {
			expect(() => panelSchema.parse({ ...tasksPanel, limit })).toThrow();
		}
		expect(() =>
			panelSchema.parse({ ...tasksPanel, limit: undefined }),
		).not.toThrow();
	});

	test("habitIds empty / 11 entries rejected", () => {
		expect(() => panelSchema.parse({ ...streakPanel, habitIds: [] })).toThrow();
		expect(() =>
			panelSchema.parse({
				...streakPanel,
				habitIds: Array.from({ length: 11 }, (_, i) => `h${i}`),
			}),
		).toThrow();
	});

	test("id / title / viewId caps enforced", () => {
		expect(() => panelSchema.parse({ ...focusPanel, id: "" })).toThrow();
		expect(() =>
			panelSchema.parse({ ...focusPanel, id: "x".repeat(65) }),
		).toThrow();
		expect(() =>
			panelSchema.parse({ ...focusPanel, title: "x".repeat(121) }),
		).toThrow();
		expect(() =>
			panelSchema.parse({
				...counterPanel,
				source: { kind: "view", viewId: "" },
			}),
		).toThrow();
	});
});

describe("panelsSchema", () => {
	test("a valid panel list parses", () => {
		expect(() =>
			panelsSchema.parse([tasksPanel, counterPanel, streakPanel, focusPanel]),
		).not.toThrow();
	});

	test("exactly MAX_PANELS accepted", () => {
		const panels = Array.from({ length: MAX_PANELS }, (_, i) => ({
			...focusPanel,
			id: `p${i}`,
		}));
		expect(() => panelsSchema.parse(panels)).not.toThrow();
	});

	test("more than MAX_PANELS rejected", () => {
		const panels = Array.from({ length: MAX_PANELS + 1 }, (_, i) => ({
			...focusPanel,
			id: `p${i}`,
		}));
		expect(() => panelsSchema.parse(panels)).toThrow();
	});

	test("duplicate ids rejected", () => {
		expect(() =>
			panelsSchema.parse([focusPanel, { ...streakPanel, id: focusPanel.id }]),
		).toThrow(/duplicate/i);
	});
});

describe("resolvePanelSource", () => {
	const display: ViewDisplay = {
		layout: "list",
		groupBy: "none",
		sort: { field: "due", dir: "desc" },
		workspaceScope: { mode: "one", id: "w1" },
	};
	const viewFilter: FilterGroup = {
		op: "and",
		conditions: [{ field: "done", operator: "is", value: false }],
	};
	const viewsById = new Map([["v1", { filter: viewFilter, display }]]);

	test("inline source passes through", () => {
		expect(resolvePanelSource(inlineSource, viewsById)).toEqual({
			filter: emptyFilter,
			sort: { field: "sortKey", dir: "asc" },
			workspaceScope: { mode: "all" },
		});
	});

	test("view ref maps filter + display sort/scope", () => {
		expect(
			resolvePanelSource({ kind: "view", viewId: "v1" }, viewsById),
		).toEqual({
			filter: viewFilter,
			sort: { field: "due", dir: "desc" },
			workspaceScope: { mode: "one", id: "w1" },
		});
	});

	test("dangling view ref resolves to null", () => {
		expect(
			resolvePanelSource({ kind: "view", viewId: "gone" }, viewsById),
		).toBeNull();
	});
});
