import { type JSX, useMemo } from "react";
import type { Panel } from "../../../domain/dashboard.ts";
import { useFocusSessions } from "../../hooks/useFocusSessions.ts";
import { focusStats } from "./focus-stats.ts";

// Own-user focus stats (shell doc: scaled-down stat treatment, label in the
// header). Sessions are always the viewer's own rows, even on shared
// dashboards -- hence the explicit "yours" hint.
export function FocusPanel({
	panel,
}: {
	panel: Extract<Panel, { type: "focus" }>;
}): JSX.Element {
	const { sessions } = useFocusSessions();
	// `now` derives inside the memo (not a dep) so stats refresh when the data
	// changes without re-running on every render (M1c pattern).
	const stats = useMemo(
		() => focusStats(sessions, panel.range, new Date()),
		[sessions, panel.range],
	);
	return (
		<div
			data-testid="focus-panel"
			className="flex h-full min-h-16 flex-col items-center justify-center gap-0.5"
		>
			<p className="text-2xl font-semibold tabular-nums">
				{stats.count}
				<span className="ms-1.5 text-sm font-normal text-muted-foreground">
					focus session{stats.count === 1 ? "" : "s"}
				</span>
			</p>
			<p
				data-testid="focus-minutes"
				className="text-sm text-muted-foreground tabular-nums"
			>
				{stats.minutes} min focused
			</p>
			<p className="text-xs text-muted-foreground/70">Your sessions only</p>
		</div>
	);
}
