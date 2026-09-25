import { useQuery, useZero } from "@rocicorp/zero/react";
import { AlertCircle, ArrowLeft, ArrowRight, RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { WRITE_ROLES } from "../../../domain/role.ts";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { queries } from "../../../zero/queries.ts";
import type { schema } from "../../../zero/schema.gen.ts";
import type { TaskImportActivationStatus } from "../../hooks/useTaskImportActivation.ts";

type ReviewItem = {
	kind:
		| "current-assignee"
		| "expected-assignee"
		| "owner-fallback"
		| "escalation-fallback";
	name: string | null;
	state: "present" | "missing" | "changed";
};
type Review = {
	task: {
		title: string;
		listTitle: string;
		parentTitle: string | null;
		fallbackPresent: boolean;
		fallbackName: string | null;
		ownerFallbackPresent: boolean;
		ownerFallbackName: string | null;
	};
	status: "pending" | "blocked";
	generation: number;
	owningRun:
		| "unfinished"
		| "terminal"
		| "plan-present"
		| "unavailable"
		| "none";
	counts: {
		currentAssignees: number;
		expectedLinks: number;
		missingLinks: number;
		changedLinks: number;
	};
	missingLinksRemainMissing: true;
	reviewDigest: string;
	items: ReviewItem[];
	page: number;
	totalItems: number;
	pageSize: number;
};

function itemKind(kind: ReviewItem["kind"]) {
	switch (kind) {
		case "current-assignee":
			return m.activation_current_assignee();
		case "expected-assignee":
			return m.activation_expected_assignee();
		case "owner-fallback":
			return m.activation_owner_fallback();
		case "escalation-fallback":
			return m.activation_escalation_fallback();
	}
}

function itemState(state: ReviewItem["state"]) {
	switch (state) {
		case "present":
			return m.activation_link_present();
		case "missing":
			return m.activation_link_missing();
		case "changed":
			return m.activation_link_changed();
	}
}

function runState(state: Review["owningRun"]) {
	switch (state) {
		case "unfinished":
			return m.activation_run_unfinished();
		case "terminal":
			return m.activation_run_terminal();
		case "plan-present":
			return m.activation_run_plan_present();
		case "unavailable":
			return m.activation_run_unavailable();
		case "none":
			return m.activation_run_none();
	}
}

export function ImportActivationRecovery({
	taskId,
	workspaceId,
	status,
	open,
}: {
	taskId: string;
	workspaceId: string;
	status: TaskImportActivationStatus;
	open: boolean;
}) {
	const zero = useZero<typeof schema>();
	const confirmId = useId();
	const [memberships] = useQuery(queries.memberships.mine());
	const role = memberships.find(
		(row) => row.userId === zero.userID && row.workspaceId === workspaceId,
	)?.role;
	const canRecover = role != null && WRITE_ROLES.has(role);
	const [review, setReview] = useState<Review | null>(null);
	const [reviewedPages, setReviewedPages] = useState<Set<number>>(new Set());
	const [busy, setBusy] = useState(false);
	const [confirmed, setConfirmed] = useState(false);
	const [finished, setFinished] = useState(false);
	const [error, setError] = useState<"stale" | "unavailable" | null>(null);
	const active = useRef<AbortController | null>(null);
	const number = (value: number) =>
		new Intl.NumberFormat(getLocale()).format(value);

	useEffect(() => {
		return () => {
			active.current?.abort();
			active.current = null;
		};
	}, []);
	// Both detail callers key this panel by task, workspace, and status, so a
	// changed identity or sync state aborts the old review before remounting.
	useEffect(() => {
		if (open) return;
		active.current?.abort();
		active.current = null;
		setReview(null);
		setReviewedPages(new Set());
		setConfirmed(false);
		setFinished(false);
		setError(null);
		setBusy(false);
	}, [open]);
	useEffect(() => {
		if (canRecover) return;
		active.current?.abort();
		active.current = null;
		setReview(null);
		setReviewedPages(new Set());
		setConfirmed(false);
		setFinished(false);
		setError(null);
		setBusy(false);
	}, [canRecover]);

	async function readPage(page: number, previous?: Review) {
		if (active.current) return;
		const controller = new AbortController();
		active.current = controller;
		setBusy(true);
		setError(null);
		try {
			const response = await fetch(
				`/api/portability/import/tasks/${encodeURIComponent(taskId)}/activation-review?page=${page}`,
				{
					credentials: "same-origin",
					cache: "no-store",
					signal: controller.signal,
				},
			);
			if (!response.ok)
				throw new Error(response.status === 409 ? "stale" : "unavailable");
			const next = (await response.json()) as Review;
			if (
				previous &&
				(next.reviewDigest !== previous.reviewDigest ||
					next.totalItems !== previous.totalItems ||
					next.page !== page)
			)
				throw new Error("stale");
			if (!controller.signal.aborted) {
				setReview(next);
				setReviewedPages(
					previous ? (pages) => new Set([...pages, page]) : new Set([page]),
				);
				setConfirmed(false);
			}
		} catch (cause) {
			if (!controller.signal.aborted) {
				setReview(null);
				setReviewedPages(new Set());
				setConfirmed(false);
				setError(
					cause instanceof Error && cause.message === "stale"
						? "stale"
						: "unavailable",
				);
			}
		} finally {
			if (active.current === controller) active.current = null;
			if (!controller.signal.aborted) setBusy(false);
		}
	}

	async function finish() {
		if (
			!review ||
			!confirmed ||
			active.current ||
			!canRecover ||
			(status !== "pending" && status !== "blocked") ||
			reviewedPages.size < Math.ceil(review.totalItems / review.pageSize)
		)
			return;
		const controller = new AbortController();
		active.current = controller;
		setBusy(true);
		setError(null);
		try {
			const response = await fetch(
				`/api/portability/import/tasks/${encodeURIComponent(taskId)}/finish`,
				{
					method: "POST",
					credentials: "same-origin",
					cache: "no-store",
					signal: controller.signal,
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						reviewDigest: review.reviewDigest,
						confirm: true,
					}),
				},
			);
			if (!response.ok)
				throw new Error(response.status === 409 ? "stale" : "unavailable");
			if (!controller.signal.aborted) {
				setFinished(true);
				setReview(null);
				setReviewedPages(new Set());
				setConfirmed(false);
			}
		} catch (cause) {
			if (!controller.signal.aborted) {
				setError(
					cause instanceof Error && cause.message === "stale"
						? "stale"
						: "unavailable",
				);
				setReview(null);
				setReviewedPages(new Set());
				setConfirmed(false);
			}
		} finally {
			if (active.current === controller) active.current = null;
			if (!controller.signal.aborted) setBusy(false);
		}
	}

	if (status === "native" || status === "active") return null;
	const isUnknown = status === "unknown";
	const totalPages = review
		? Math.ceil(review.totalItems / review.pageSize)
		: 0;
	return (
		<section
			className="rounded-xl border bg-muted/30 p-4"
			data-testid="task-import-activation"
		>
			<div className="flex items-start gap-3">
				<AlertCircle
					aria-hidden="true"
					className="mt-0.5 size-5 shrink-0 text-amber-600"
				/>
				<div className="min-w-0 flex-1 space-y-2">
					<h3 className="font-medium">
						{isUnknown
							? m.activation_status_checking()
							: status === "pending"
								? m.activation_status_pending()
								: m.activation_status_blocked()}
					</h3>
					<p className="text-sm text-muted-foreground">
						{isUnknown
							? m.activation_unknown_explanation()
							: m.activation_paused_explanation()}
					</p>
				</div>
			</div>
			<div role="status" aria-live="polite" className="mt-3 text-sm">
				{busy && <p>{m.activation_review_loading()}</p>}
				{finished && <p>{m.activation_finished_waiting()}</p>}
				{error && (
					<p className="text-destructive">
						{error === "stale"
							? m.activation_review_stale()
							: m.activation_review_error()}
					</p>
				)}
			</div>
			{canRecover && !isUnknown && !review && !finished && (
				<Button
					variant="outline"
					className="mt-3 min-h-11"
					disabled={busy}
					onClick={() => void readPage(0)}
				>
					<RefreshCw aria-hidden="true" />{" "}
					{error ? m.activation_review_again() : m.activation_review_action()}
				</Button>
			)}
			{review && canRecover && !isUnknown && (
				<div className="mt-4 space-y-4 border-t pt-4">
					<div className="space-y-1 text-sm">
						<p className="font-medium">{m.activation_review_heading()}</p>
						<p>
							{m.activation_review_items({ count: number(review.totalItems) })}
						</p>
						<p>
							{m.activation_review_location({ list: review.task.listTitle })}
						</p>
						{review.task.parentTitle && (
							<p>
								{m.activation_review_parent({ title: review.task.parentTitle })}
							</p>
						)}
						<p>
							{m.activation_review_assignees({
								count: number(review.counts.currentAssignees),
							})}
						</p>
						<p>
							{m.activation_review_fallback({
								name: review.task.fallbackPresent
									? (review.task.fallbackName ??
										m.activation_person_unavailable())
									: m.activation_none(),
							})}
						</p>
						{review.task.ownerFallbackPresent && (
							<p>
								{m.activation_review_owner_fallback({
									name:
										review.task.ownerFallbackName ??
										m.activation_person_unavailable(),
								})}
							</p>
						)}
						<p>
							{m.activation_review_links({
								expected: number(review.counts.expectedLinks),
								missing: number(review.counts.missingLinks),
								changed: number(review.counts.changedLinks),
							})}
						</p>
						<p>{runState(review.owningRun)}</p>
					</div>
					{review.totalItems > 0 && (
						<div className="space-y-2">
							<ul
								// biome-ignore lint/a11y/noNoninteractiveTabindex: The overflow review must be keyboard-scrollable.
								tabIndex={0}
								aria-label={m.activation_review_heading()}
								className="max-h-44 space-y-1 overflow-y-auto rounded-lg border bg-background p-2 text-sm"
							>
								{review.items.map((item, index) => (
									<li
										// biome-ignore lint/suspicious/noArrayIndexKey: The digest fixes page order and these rows hold no local state.
										key={`${review.page}-${index}`}
										className="flex flex-wrap items-center gap-2"
									>
										<span className="font-medium">
											{item.name ?? m.activation_person_unavailable()}
										</span>
										<span className="text-muted-foreground">
											{itemKind(item.kind)}
										</span>
										<Badge
											variant={
												item.state === "present" ? "secondary" : "outline"
											}
										>
											{itemState(item.state)}
										</Badge>
									</li>
								))}
							</ul>
							{totalPages > 1 && (
								<div className="flex items-center justify-between gap-2">
									<Button
										variant="outline"
										size="sm"
										className="min-h-11"
										disabled={busy || review.page === 0}
										onClick={() => void readPage(review.page - 1, review)}
										aria-label={m.activation_previous_page()}
									>
										<ArrowLeft aria-hidden="true" className="rtl:rotate-180" />{" "}
										{m.activation_previous_page()}
									</Button>
									<span className="text-xs text-muted-foreground">
										{m.activation_page_count({
											page: number(review.page + 1),
											total: number(totalPages),
										})}
									</span>
									<Button
										variant="outline"
										size="sm"
										className="min-h-11"
										disabled={busy || review.page + 1 >= totalPages}
										onClick={() => void readPage(review.page + 1, review)}
										aria-label={m.activation_next_page()}
									>
										{m.activation_next_page()}{" "}
										<ArrowRight aria-hidden="true" className="rtl:rotate-180" />
									</Button>
								</div>
							)}
						</div>
					)}
					<div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
						<p>{m.activation_missing_remains()}</p>
						<p>{m.activation_future_only()}</p>
						<p>{m.activation_overdue_history()}</p>
						<p>{m.activation_paused_occurrences()}</p>
						<p>{m.activation_queued_delivery()}</p>
					</div>
					<label htmlFor={confirmId} className="flex items-start gap-2 text-sm">
						<Checkbox
							id={confirmId}
							checked={confirmed}
							onCheckedChange={(checked) => setConfirmed(checked === true)}
							aria-label={m.activation_confirm_label()}
						/>
						<span>{m.activation_confirm_label()}</span>
					</label>
					{reviewedPages.size < totalPages && (
						<p className="text-sm text-muted-foreground">
							{m.activation_review_all_pages()}
						</p>
					)}
					<div className="flex flex-wrap gap-2">
						<Button
							disabled={
								busy ||
								!confirmed ||
								!canRecover ||
								isUnknown ||
								reviewedPages.size < totalPages
							}
							className="min-h-11"
							onClick={() => void finish()}
						>
							{m.activation_finish_action()}
						</Button>
						<Button
							variant="outline"
							disabled={busy}
							className="min-h-11"
							onClick={() => {
								setReview(null);
								setConfirmed(false);
							}}
						>
							{m.confirm_cancel()}
						</Button>
					</div>
				</div>
			)}
		</section>
	);
}
