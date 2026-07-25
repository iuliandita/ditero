// Pure dashboard panel model. Panels persist as JSONB on the dashboard table;
// mutators validate with panelsSchema (single source of truth for panel shape)
// and the renderer consumes PANEL_SPANS + resolvePanelSource. No Zero, no DB,
// no React.
import { z } from "zod";
import {
	type FilterGroup,
	filterGroupSchema,
	type ViewDisplay,
	type WorkspaceScope,
	workspaceScopeSchema,
} from "./view-filter.ts";

export type PanelSize = "s" | "m" | "l" | "full";
export const PANEL_SPANS: Record<PanelSize, number> = {
	s: 3,
	m: 6,
	l: 8,
	full: 12,
};
export const MAX_PANELS = 20;
export const DEFAULT_PANEL_LIMIT = 10;
// Tasks-panel row cap bounds; the editor renders and validates against these.
export const MIN_PANEL_LIMIT = 1;
export const MAX_PANEL_LIMIT = 50;

export type PanelSource =
	| { kind: "view"; viewId: string }
	| {
			kind: "inline";
			filter: FilterGroup;
			sort: { field: string; dir: "asc" | "desc" };
			workspaceScope: WorkspaceScope;
	  };

export type Panel =
	| {
			id: string;
			type: "tasks";
			source: PanelSource;
			size: PanelSize;
			title?: string;
			limit?: number; // 1..50, default applied at render
	  }
	| {
			id: string;
			type: "counter";
			source: PanelSource;
			size: PanelSize;
			title?: string;
	  }
	| {
			id: string;
			type: "streak";
			habitIds: string[]; // 1..10
			size: PanelSize;
			title?: string;
	  }
	| {
			id: string;
			type: "focus";
			range: "today" | "week";
			size: PanelSize;
			title?: string;
	  };

const sortSchema = z
	.object({
		field: z.string().min(1).max(40),
		dir: z.enum(["asc", "desc"]),
	})
	.strict();

const panelSourceSchema: z.ZodType<PanelSource> = z.discriminatedUnion("kind", [
	z
		.object({ kind: z.literal("view"), viewId: z.string().min(1).max(64) })
		.strict(),
	z
		.object({
			kind: z.literal("inline"),
			filter: filterGroupSchema,
			sort: sortSchema,
			workspaceScope: workspaceScopeSchema,
		})
		.strict(),
]);

const panelId = z.string().min(1).max(64);
const panelTitle = z.string().max(120).optional();
const panelSize = z.enum(["s", "m", "l", "full"]);

export const panelSchema: z.ZodType<Panel> = z.discriminatedUnion("type", [
	z
		.object({
			id: panelId,
			type: z.literal("tasks"),
			source: panelSourceSchema,
			size: panelSize,
			title: panelTitle,
			limit: z
				.number()
				.int()
				.min(MIN_PANEL_LIMIT)
				.max(MAX_PANEL_LIMIT)
				.optional(),
		})
		.strict(),
	z
		.object({
			id: panelId,
			type: z.literal("counter"),
			source: panelSourceSchema,
			size: panelSize,
			title: panelTitle,
		})
		.strict(),
	z
		.object({
			id: panelId,
			type: z.literal("streak"),
			habitIds: z.array(z.string().min(1).max(64)).min(1).max(10),
			size: panelSize,
			title: panelTitle,
		})
		.strict(),
	z
		.object({
			id: panelId,
			type: z.literal("focus"),
			range: z.enum(["today", "week"]),
			size: panelSize,
			title: panelTitle,
		})
		.strict(),
]);

export const panelsSchema: z.ZodType<Panel[]> = z
	.array(panelSchema)
	.max(MAX_PANELS)
	.superRefine((panels, refCtx) => {
		const seen = new Set<string>();
		for (const panel of panels) {
			if (seen.has(panel.id)) {
				refCtx.addIssue({
					code: "custom",
					message: `dashboard: duplicate panel id '${panel.id}'`,
				});
			}
			seen.add(panel.id);
		}
	});

export type ResolvedSource = {
	filter: FilterGroup;
	sort: { field: string; dir: "asc" | "desc" };
	workspaceScope: WorkspaceScope;
};

// null => dangling view ref ("view missing"); render surfaces it, never throws.
export function resolvePanelSource(
	source: PanelSource,
	viewsById: ReadonlyMap<string, { filter: FilterGroup; display: ViewDisplay }>,
): ResolvedSource | null {
	if (source.kind === "inline") {
		return {
			filter: source.filter,
			sort: source.sort,
			workspaceScope: source.workspaceScope,
		};
	}
	const view = viewsById.get(source.viewId);
	if (view === undefined) return null;
	return {
		filter: view.filter,
		sort: view.display.sort,
		workspaceScope: view.display.workspaceScope,
	};
}
