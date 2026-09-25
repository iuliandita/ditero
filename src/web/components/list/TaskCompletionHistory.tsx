import { useConnectionState, useQuery, useZero } from "@rocicorp/zero/react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { queries } from "../../../zero/queries.ts";
import type { schema } from "../../../zero/schema.gen.ts";
import { formatDayKey } from "../../lib/intl-format.ts";

type Cursor = { recordedAt: number; id: string };
type HistoryRow = Cursor & {
	action: "complete" | "reopen" | "skip" | "habit_set" | "habit_unlog";
	origin: "member_mutation" | "capability_recipient";
	beforeDueAt: number | null;
	beforeDueAllDay: boolean | null;
	habitDate: string | null;
	beforeHabitStatus: "done" | "skipped" | null;
	afterHabitStatus: "done" | "skipped" | null;
	actor?: { name: string | null } | null;
};

function formatInstant(at: number, allDay = false) {
	return new Intl.DateTimeFormat(getLocale(), {
		dateStyle: "medium",
		...(allDay ? {} : { timeStyle: "short" as const }),
	}).format(at);
}

function historyAction(row: HistoryRow, person: string) {
	const reminder = row.origin === "capability_recipient";
	switch (row.action) {
		case "complete":
			return reminder
				? m.completion_history_complete_link({ recipient: person })
				: m.completion_history_complete_member({ actor: person });
		case "reopen":
			return reminder
				? m.completion_history_reopen_link({ recipient: person })
				: m.completion_history_reopen_member({ actor: person });
		case "skip":
			return reminder
				? m.completion_history_skip_link({ recipient: person })
				: m.completion_history_skip_member({ actor: person });
		case "habit_set":
			if (row.afterHabitStatus === "done")
				return reminder
					? m.completion_history_habit_done_link({ recipient: person })
					: m.completion_history_habit_done_member({ actor: person });
			return reminder
				? m.completion_history_habit_skipped_link({ recipient: person })
				: m.completion_history_habit_skipped_member({ actor: person });
		case "habit_unlog":
			return reminder
				? m.completion_history_habit_removed_link({ recipient: person })
				: m.completion_history_habit_removed_member({ actor: person });
	}
}

function HistoryPage({ taskId }: { taskId: string }) {
	const [cursors, setCursors] = useState<(Cursor | null)[]>([null]);
	const page = cursors.length - 1;
	const connection = useConnectionState();
	const [browserOnline, setBrowserOnline] = useState(
		() => typeof navigator === "undefined" || navigator.onLine,
	);
	const [rows, details] = useQuery(
		queries.taskCompletionEvents.page({ taskId, cursor: cursors[page] }),
	);
	useEffect(() => {
		const update = () => setBrowserOnline(navigator.onLine);
		window.addEventListener("online", update);
		window.addEventListener("offline", update);
		return () => {
			window.removeEventListener("online", update);
			window.removeEventListener("offline", update);
		};
	}, []);

	const complete = details.type === "complete";
	const hasNext = complete && rows.length === 100;
	const showPartial = !complete && details.type !== "error";
	return (
		<div className="space-y-3 pt-2" data-testid="completion-history-page">
			<p className="text-xs text-muted-foreground">
				{m.completion_history_future_only()}
			</p>
			{rows.length > 0 && details.type !== "error" && (
				<ol className="space-y-2">
					{rows.map((row) => {
						const person =
							row.actor?.name?.trim() ||
							m.completion_history_person_unavailable();
						const occurrence =
							row.habitDate != null
								? formatDayKey(row.habitDate, {
										dateStyle: "medium",
									})
								: row.beforeDueAt == null
									? m.completion_history_occurrence_unknown()
									: formatInstant(
											row.beforeDueAt,
											row.beforeDueAllDay === true,
										);
						return (
							<li
								key={row.id}
								className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-sm"
								data-testid="completion-history-row"
							>
								<p className="font-medium">{historyAction(row, person)}</p>
								<p className="mt-1 text-xs text-muted-foreground">
									{m.completion_history_occurrence({ occurrence })}
								</p>
								<time
									dateTime={new Date(row.recordedAt).toISOString()}
									className="block text-xs text-muted-foreground"
								>
									{m.completion_history_recorded({
										time: formatInstant(row.recordedAt),
									})}
								</time>
							</li>
						);
					})}
				</ol>
			)}
			{details.type === "error" ? (
				<div role="alert" className="space-y-2 text-sm text-destructive">
					<p>{m.completion_history_error()}</p>
					<Button
						type="button"
						variant="outline"
						onClick={details.retry}
						className="min-h-11"
					>
						{m.completion_history_retry()}
					</Button>
				</div>
			) : showPartial ? (
				<p role="status" className="text-sm text-muted-foreground">
					{browserOnline &&
					(connection.name === "connected" || connection.name === "connecting")
						? m.completion_history_loading()
						: m.completion_history_offline_incomplete()}
				</p>
			) : rows.length === 0 ? (
				<p role="status" className="text-sm text-muted-foreground">
					{page === 0
						? m.completion_history_empty()
						: m.completion_history_end()}
				</p>
			) : null}
			{(page > 0 || hasNext) && (
				<div className="flex flex-wrap items-center justify-between gap-2">
					<Button
						type="button"
						variant="outline"
						className="min-h-11"
						disabled={page === 0}
						onClick={() => setCursors((current) => current.slice(0, -1))}
					>
						<ChevronLeft aria-hidden="true" className="rtl:rotate-180" />
						{m.completion_history_previous()}
					</Button>
					<span aria-live="polite" className="text-xs text-muted-foreground">
						{m.completion_history_page({ page: page + 1 })}
					</span>
					<Button
						type="button"
						variant="outline"
						className="min-h-11"
						disabled={!hasNext}
						onClick={() => {
							const last = rows.at(-1);
							if (last)
								setCursors((current) => [
									...current,
									{ recordedAt: last.recordedAt, id: last.id },
								]);
						}}
					>
						{m.completion_history_next()}
						<ChevronRight aria-hidden="true" className="rtl:rotate-180" />
					</Button>
				</div>
			)}
		</div>
	);
}

export function TaskCompletionHistory({
	taskId,
	workspaceId,
	detailOpen,
}: {
	taskId: string;
	workspaceId: string;
	detailOpen: boolean;
}) {
	const zero = useZero<typeof schema>();
	const panelId = useId();
	const [expanded, setExpanded] = useState(false);
	const [memberships, membershipDetails] = useQuery(queries.memberships.mine());
	const [tasks, taskDetails] = useQuery(queries.tasks.mine());
	const [lists, listDetails] = useQuery(queries.lists.mine());
	const member = memberships.some(
		(row) => row.userId === zero.userID && row.workspaceId === workspaceId,
	);
	const task = tasks.find((row) => row.id === taskId);
	const list = lists.find(
		(row) => row.id === task?.listId && row.workspaceId === workspaceId,
	);
	const visible = member && task != null && list != null;
	const unavailable =
		(!member && membershipDetails.type === "complete") ||
		(task == null && taskDetails.type === "complete") ||
		(list == null && listDetails.type === "complete");

	useEffect(() => {
		if (!detailOpen) setExpanded(false);
	}, [detailOpen]);

	return (
		<section className="border-t pt-3" data-testid="completion-history">
			<h3>
				<Button
					type="button"
					variant="ghost"
					className="min-h-11 w-full justify-between px-1 text-start font-semibold"
					aria-expanded={expanded && detailOpen}
					aria-controls={panelId}
					onClick={() => setExpanded((current) => !current)}
				>
					{m.completion_history_heading()}
					<ChevronDown
						aria-hidden="true"
						className={expanded ? "rotate-180" : undefined}
					/>
				</Button>
			</h3>
			{expanded && detailOpen && (
				<div id={panelId}>
					{visible ? (
						<HistoryPage
							key={JSON.stringify([taskId, workspaceId])}
							taskId={taskId}
						/>
					) : (
						<p role="status" className="pt-2 text-sm text-muted-foreground">
							{unavailable
								? m.completion_history_unavailable()
								: m.completion_history_loading()}
						</p>
					)}
				</div>
			)}
		</section>
	);
}
