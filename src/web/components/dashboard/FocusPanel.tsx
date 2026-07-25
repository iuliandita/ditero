import { type JSX, useMemo } from "react";
import type { Panel } from "../../../domain/dashboard.ts";
import { m } from "../../../paraglide/messages.js";
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
					{m.panel_focus_sessions_unit({ count: stats.count })}
				</span>
			</p>
			<p
				data-testid="focus-minutes"
				className="text-sm text-muted-foreground tabular-nums"
			>
				{m.panel_focus_minutes({ minutes: stats.minutes })}
			</p>
			{/* Full-strength muted token: the /70 variant fails the WCAG AA 4.5:1
			    contrast gate (axe serious) at this size. */}
			<p className="text-xs text-muted-foreground">
				{m.panel_focus_own_only()}
			</p>
		</div>
	);
}
