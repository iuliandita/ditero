import { type JSX, useMemo, useState } from "react";
import type { Panel, ResolvedSource } from "../../../domain/dashboard.ts";
import { m } from "../../../paraglide/messages.js";
import type { Task } from "../../../zero/schema.gen.ts";
import {
	orderForPanel,
	type PanelData,
	PanelExpandDialog,
	type PanelIds,
	type PanelRowOptions,
	PanelTaskList,
	usePanelEntries,
	usePanelRowHandlers,
} from "./panel-shared.tsx";
import { capEntries } from "./panel-tasks.ts";

export function TasksPanel({
	panel,
	resolved,
	label,
	data,
	ids,
	byPriority,
	showCompleted,
	onOpenTask,
	onOpenView,
}: {
	panel: Extract<Panel, { type: "tasks" }>;
	resolved: ResolvedSource;
	label: string;
	data: PanelData;
	ids: PanelIds;
	// The source view groups by priority, so the panel sections by it too.
	byPriority: boolean;
	// The source filter asks about completion; otherwise done rows stay out.
	showCompleted: boolean;
	onOpenTask: (task: Task) => void;
	onOpenView: (viewId: string) => void;
}): JSX.Element {
	const matching = usePanelEntries(data, resolved, ids);
	const entries = useMemo(
		() =>
			orderForPanel(
				showCompleted ? matching : matching.filter((e) => !e.task.done),
				byPriority,
			),
		[matching, showCompleted, byPriority],
	);
	const options = useMemo<PanelRowOptions>(() => {
		const byId = new Map(data.lists.map((l) => [l.id, l]));
		const spans = new Set(entries.map((e) => e.task.listId)).size > 1;
		return {
			byPriority,
			listOf: spans
				? (id) => {
						const list = byId.get(id);
						return {
							title: list?.title || m.list_untitled_fallback(),
							icon: list?.icon ?? null,
						};
					}
				: null,
		};
	}, [data.lists, entries, byPriority]);
	const { handlers, error } = usePanelRowHandlers(onOpenTask);
	const [expanded, setExpanded] = useState(false);
	const capped = capEntries(entries, panel.limit);
	const source = panel.source;

	return (
		<div data-testid="tasks-panel">
			{/* While the expand dialog is open it owns the role="alert" error;
			    mounting both would double the SR announcement. */}
			{error && !expanded && (
				<p role="alert" className="mb-2 text-sm text-destructive">
					{error}
				</p>
			)}
			{entries.length === 0 ? (
				<p
					data-testid="panel-no-matches"
					className="text-sm text-muted-foreground"
				>
					{matching.length === 0 ? m.panel_no_matches() : m.panel_all_done()}
				</p>
			) : (
				<PanelTaskList entries={capped} handlers={handlers} options={options} />
			)}
			{entries.length > capped.length && (
				<button
					type="button"
					data-testid="panel-show-all"
					onClick={() =>
						source.kind === "view"
							? onOpenView(source.viewId)
							: setExpanded(true)
					}
					className="mt-1 rounded px-1 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
				>
					{m.panel_show_all({ count: entries.length })}
				</button>
			)}
			<PanelExpandDialog
				open={expanded}
				onOpenChange={setExpanded}
				label={label}
				entries={entries}
				handlers={handlers}
				options={options}
				error={error}
			/>
		</div>
	);
}
