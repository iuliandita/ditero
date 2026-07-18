import { type JSX, useState } from "react";
import type { Panel, ResolvedSource } from "../../../domain/dashboard.ts";
import type { Task } from "../../../zero/schema.gen.ts";
import {
	type PanelData,
	PanelExpandDialog,
	type PanelIds,
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
	onOpenTask,
	onOpenView,
}: {
	panel: Extract<Panel, { type: "tasks" }>;
	resolved: ResolvedSource;
	label: string;
	data: PanelData;
	ids: PanelIds;
	onOpenTask: (task: Task) => void;
	onOpenView: (viewId: string) => void;
}): JSX.Element {
	const entries = usePanelEntries(data, resolved, ids);
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
					No matching tasks
				</p>
			) : (
				<PanelTaskList entries={capped} handlers={handlers} />
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
					Show all ({entries.length})
				</button>
			)}
			<PanelExpandDialog
				open={expanded}
				onOpenChange={setExpanded}
				label={label}
				entries={entries}
				handlers={handlers}
				error={error}
			/>
		</div>
	);
}
