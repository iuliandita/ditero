import { type JSX, useState } from "react";
import type { Panel, ResolvedSource } from "../../../domain/dashboard.ts";
import type { Task } from "../../../zero/schema.gen.ts";
import {
	type PanelData,
	PanelExpandDialog,
	type PanelIds,
	usePanelEntries,
	usePanelRowHandlers,
} from "./panel-shared.tsx";

// Big-number tile (shell doc §1): one dominant tabular-nums numeral centered
// in the body, label stays in the header, whole tile a click-through with the
// same semantics as "Show all". Counts the FULL matching set (never limited);
// zero renders 0, never blank.
export function CounterPanel({
	panel,
	resolved,
	label,
	data,
	ids,
	onOpenTask,
	onOpenView,
}: {
	panel: Extract<Panel, { type: "counter" }>;
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
	const source = panel.source;

	return (
		<>
			<button
				type="button"
				data-testid="counter-tile"
				aria-label={`${label}: ${entries.length} matching tasks. Show them`}
				onClick={() =>
					source.kind === "view" ? onOpenView(source.viewId) : setExpanded(true)
				}
				className="flex h-full min-h-16 w-full items-center justify-center rounded-md hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			>
				<span className="text-4xl font-semibold tabular-nums">
					{entries.length}
				</span>
			</button>
			<PanelExpandDialog
				open={expanded}
				onOpenChange={setExpanded}
				label={label}
				entries={entries}
				handlers={handlers}
				error={error}
			/>
		</>
	);
}
