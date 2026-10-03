import { useConnectionState, useQuery, useZero } from "@rocicorp/zero/react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
	HistoryCursor as Cursor,
	HistoryPage as HistoryPageData,
	HistoryRow,
} from "../../../domain/task-history.ts";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { queries } from "../../../zero/queries.ts";
import type { schema } from "../../../zero/schema.gen.ts";
import { formatDayKey } from "../../lib/intl-format.ts";
import {
	loadTaskHistory,
	TaskHistoryUnavailableError,
} from "../../lib/task-history.ts";

function formatInstant(at: number, allDay = false) {
	return new Intl.DateTimeFormat(getLocale(), {
		dateStyle: "medium",
		...(allDay ? {} : { timeStyle: "short" as const }),
	}).format(at);
}

function historyAction(row: HistoryRow, person: string) {
	if (row.sourceKind === "imported") {
		switch (row.action) {
			case "complete":
				return m.completion_history_imported_complete();
			case "reopen":
				return m.completion_history_imported_reopen();
			case "skip":
				return m.completion_history_imported_skip();
			case "habit_set":
				return row.afterHabitStatus === "done"
					? m.completion_history_imported_habit_done()
					: m.completion_history_imported_habit_skipped();
			case "habit_unlog":
				return m.completion_history_imported_habit_removed();
		}
	}
	const reminder = row.origin.mechanism === "capability_recipient";
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

function HistoryPage({
	taskId,
	workspaceId,
	refused,
	onAuthorization,
}: {
	taskId: string;
	workspaceId: string;
	refused: boolean;
	onAuthorization: (available: boolean) => void;
}) {
	const [cursors, setCursors] = useState<(Cursor | null)[]>([null]);
	const page = cursors.length - 1;
	const connection = useConnectionState();
	const [browserOnline, setBrowserOnline] = useState(
		() => typeof navigator === "undefined" || navigator.onLine,
	);
	const cursor = cursors[page] ?? null;
	const [nativeRows] = useQuery(
		queries.taskCompletionEvents.page({
			taskId,
			cursor: cursor
				? {
						recordedAt: cursor.recordedAt,
						id: cursor.sourceKind === "native" ? cursor.id : "",
					}
				: null,
		}),
	);
	const key = JSON.stringify(cursor);
	const [request, setRequest] = useState<{
		key: string;
		status: "loading" | "complete" | "error" | "unavailable";
		data: HistoryPageData | null;
	}>({ key, status: "loading", data: null });
	const [revision, retry] = useState(0);
	const nativeRevision = JSON.stringify(
		nativeRows.map((row) => [row.id, row.recordedAt, row.actor?.name]),
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Retries and synced native events refresh the merged page.
	useEffect(() => {
		const controller = new AbortController();
		if (!browserOnline) {
			setRequest((current) => ({
				key,
				status: "loading",
				data: current.key === key ? current.data : null,
			}));
			return () => controller.abort();
		}
		setRequest((current) => ({
			key,
			status: "loading",
			data: current.key === key ? current.data : null,
		}));
		void loadTaskHistory(
			taskId,
			workspaceId,
			JSON.parse(key) as Cursor | null,
			controller.signal,
		).then(
			(data) => {
				if (!controller.signal.aborted) {
					onAuthorization(true);
					setRequest({ key, status: "complete", data });
				}
			},
			(error) => {
				if (!controller.signal.aborted) {
					if (error instanceof TaskHistoryUnavailableError)
						onAuthorization(false);
					setRequest({
						key,
						status:
							error instanceof TaskHistoryUnavailableError
								? "unavailable"
								: "error",
						data: null,
					});
				}
			},
		);
		return () => controller.abort();
	}, [
		taskId,
		workspaceId,
		key,
		browserOnline,
		revision,
		nativeRevision,
		onAuthorization,
	]);
	const rows: readonly HistoryRow[] = refused
		? []
		: request.key === key && request.data
			? request.data.rows
			: nativeRows.map((row) => ({
					recordedAt: row.recordedAt,
					id: row.id,
					sourceKind: "native" as const,
					action: row.action,
					origin: {
						kind: "native" as const,
						mechanism: row.origin,
						label: null,
					},
					actor: {
						kind: row.actor?.name
							? ("native_user" as const)
							: ("unknown" as const),
						displayName: row.actor?.name ?? null,
					},
					beforeDueAt: row.beforeDueAt ?? null,
					beforeDueAllDay: row.beforeDueAllDay ?? null,
					habitDate: row.habitDate ?? null,
					afterHabitStatus: row.afterHabitStatus ?? null,
					provenanceRedactedAt: null,
				}));
	const details = {
		type: refused
			? "unavailable"
			: request.key === key
				? request.status
				: "loading",
		retry: () => retry((current) => current + 1),
	};
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
	const knownNext = request.key === key && request.data?.nextCursor != null;
	const hasNext = complete && browserOnline && knownNext;
	const showPartial =
		(!complete || !browserOnline) &&
		details.type !== "error" &&
		details.type !== "unavailable";
	return (
		<div className="space-y-3 pt-2" data-testid="completion-history-page">
			<p className="text-xs text-muted-foreground">
				{m.completion_history_future_only()}
			</p>
			{rows.length > 0 &&
				details.type !== "error" &&
				details.type !== "unavailable" && (
					<ol className="space-y-2">
						{rows.map((row) => {
							const person =
								row.actor.displayName?.trim() ||
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
									key={JSON.stringify([row.sourceKind, row.id])}
									className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-sm wrap-anywhere"
									data-testid="completion-history-row"
								>
									<p className="font-medium">{historyAction(row, person)}</p>
									{row.sourceKind === "imported" && (
										<div
											className="mt-1 text-xs text-muted-foreground"
											data-testid="history-imported-attribution"
										>
											<p>
												{row.actor.kind === "source_claim" &&
												row.actor.displayName
													? m.completion_history_imported_actor({
															name: `\u2068${row.actor.displayName}\u2069`,
														})
													: m.completion_history_imported_actor_unknown()}
											</p>
											<p>
												{row.origin.kind === "source_claim"
													? m.completion_history_imported_origin({
															origin: `\u2068${row.origin.label || (row.origin.mechanism === "capability_recipient" ? m.completion_history_origin_link() : row.origin.mechanism === "member_mutation" ? m.completion_history_origin_member() : m.completion_history_origin_unknown())}\u2069`,
														})
													: m.completion_history_imported_origin_unknown()}
											</p>
											{row.provenanceRedactedAt != null && (
												<p>{m.completion_history_imported_redacted()}</p>
											)}
										</div>
									)}
									<p className="mt-1 text-xs text-muted-foreground">
										{m.completion_history_occurrence({ occurrence })}
									</p>
									<time
										dateTime={new Date(row.recordedAt).toISOString()}
										className="block text-xs text-muted-foreground"
									>
										{row.sourceKind === "imported"
											? m.completion_history_occurred({
													time: formatInstant(row.recordedAt),
												})
											: m.completion_history_recorded({
													time: formatInstant(row.recordedAt),
												})}
									</time>
								</li>
							);
						})}
					</ol>
				)}
			{details.type === "unavailable" ? (
				<div className="space-y-2 text-sm text-muted-foreground">
					<p role="status">{m.completion_history_unavailable()}</p>
					<Button
						type="button"
						variant="outline"
						onClick={details.retry}
						disabled={!browserOnline || request.status === "loading"}
						className="min-h-11"
					>
						{m.completion_history_retry()}
					</Button>
				</div>
			) : details.type === "error" ? (
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
			{(page > 0 || knownNext) && (
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
							const next = request.data?.nextCursor;
							if (next && complete && browserOnline)
								setCursors((current) => [...current, next]);
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
	const scope = JSON.stringify([zero.userID, taskId, workspaceId]);
	const [refusedScope, setRefusedScope] = useState<string | null>(null);
	const onAuthorization = useCallback(
		(available: boolean) => setRefusedScope(available ? null : scope),
		[scope],
	);
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
			<h2>
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
			</h2>
			{expanded && detailOpen && (
				<div id={panelId}>
					{visible ? (
						<HistoryPage
							key={scope}
							taskId={taskId}
							workspaceId={workspaceId}
							refused={refusedScope === scope}
							onAuthorization={onAuthorization}
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
