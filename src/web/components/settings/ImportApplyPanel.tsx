import { useEffect, useRef, useState } from "react";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { Button } from "../ui/button.tsx";
import { useConfirm } from "../ui/confirm.tsx";

type Run = {
	jobId: string;
	state: "pending" | "running" | "conflict" | "completed";
	nextOrdinal: number;
	appliedCount: number;
	noopCount: number;
	conflictCode: string | null;
	conflictOrdinal: number | null;
};
type Plan = {
	id: string;
	planDigest: string;
	report: {
		plannerVersion: 1 | 2 | 3 | 4;
		applySupported: boolean;
		counts: { ensure: number; ignored: number; blocked: number };
	};
};

// The parent keys this component by plan ID so confirmation never crosses plans.
export function ImportApplyPanel({
	plan,
	onBusy,
	disabled,
}: {
	plan: Plan;
	onBusy: (busy: boolean) => void;
	disabled: boolean;
}) {
	const confirm = useConfirm();
	const active = useRef<AbortController | null>(null);
	const approved = useRef(false);
	const alive = useRef(true);
	const [run, setRun] = useState<Run | null>(null);
	const [loading, setLoading] = useState(true);
	const [applying, setApplying] = useState(false);
	const [paused, setPaused] = useState(false);
	const [error, setError] = useState<"status" | "apply" | "conflict" | null>(
		null,
	);
	const [reload, setReload] = useState(0);
	const path = `/api/portability/import/plans/${encodeURIComponent(plan.id)}`;
	const supported =
		plan.report.applySupported &&
		(plan.report.plannerVersion === 2 ||
			plan.report.plannerVersion === 3 ||
			plan.report.plannerVersion === 4);
	const counts = plan.report.counts;
	const total = counts.ensure + counts.ignored + counts.blocked;
	const number = (value: number) =>
		new Intl.NumberFormat(getLocale()).format(value);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reload explicitly retries a failed status read.
	useEffect(() => {
		alive.current = true;
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		void (async () => {
			try {
				const response = await fetch(`${path}/run`, {
					signal: controller.signal,
					credentials: "same-origin",
					cache: "no-store",
				});
				if (!response.ok) throw new Error("Import status unavailable");
				const body = (await response.json()) as { run: Run | null };
				if (!controller.signal.aborted) setRun(body.run);
			} catch {
				if (!controller.signal.aborted) setError("status");
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		})();
		return () => {
			alive.current = false;
			controller.abort();
			active.current?.abort();
			onBusy(false);
		};
	}, [path, reload, onBusy]);

	async function apply() {
		if (
			!supported ||
			disabled ||
			active.current ||
			loading ||
			error === "status" ||
			error === "conflict" ||
			run?.state === "completed" ||
			run?.state === "conflict"
		)
			return;
		const controller = new AbortController();
		active.current = controller;
		onBusy(true);
		try {
			if (!approved.current) {
				const ok = await confirm({
					title: m.import_apply_action(),
					body: m.import_apply_confirm({
						eligible: number(counts.ensure),
						ignored: number(counts.ignored),
						blocked: number(counts.blocked),
					}),
					confirmLabel: m.import_apply_action(),
				});
				if (!ok || controller.signal.aborted || !alive.current) return;
				approved.current = true;
			}
			setApplying(true);
			setPaused(false);
			setError(null);
			let previous = run?.nextOrdinal ?? -1;
			while (!controller.signal.aborted) {
				const response = await fetch(`${path}/apply`, {
					method: "POST",
					credentials: "same-origin",
					signal: controller.signal,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ planDigest: plan.planDigest, counts }),
				});
				if (controller.signal.aborted || !alive.current) return;
				if (response.status === 409) {
					setError("conflict");
					return;
				}
				if (!response.ok) throw new Error("Import batch failed");
				const next = (await response.json()) as Run;
				if (controller.signal.aborted) return;
				setRun(next);
				if (next.state !== "running") return;
				if (next.nextOrdinal <= previous)
					throw new Error("Import did not advance");
				previous = next.nextOrdinal;
			}
		} catch {
			if (!controller.signal.aborted) setError("apply");
		} finally {
			if (active.current === controller) {
				active.current = null;
				if (alive.current) {
					setApplying(false);
					onBusy(false);
				}
			}
		}
	}
	const terminal =
		run?.state === "completed" ||
		run?.state === "conflict" ||
		error === "conflict";
	return (
		<div className="mt-3 space-y-2 border-t pt-3">
			<div
				role="status"
				aria-live="polite"
				data-testid="import-apply-status"
				className="space-y-2 text-sm"
			>
				{loading ? (
					<p>{m.import_apply_loading()}</p>
				) : (
					run && (
						<p>
							{m.import_apply_progress({
								processed: number(run.nextOrdinal),
								total: number(total),
								imported: number(run.appliedCount),
								unchanged: number(run.noopCount),
							})}
						</p>
					)
				)}
				{run?.state === "completed" && <p>{m.import_apply_completed()}</p>}
				{run?.state === "conflict" && <p>{m.import_apply_conflict()}</p>}
				{paused && !terminal && <p>{m.import_apply_paused()}</p>}
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error === "status"
						? m.import_plan_failed()
						: error === "conflict"
							? m.import_apply_conflict()
							: m.import_apply_failed()}
				</p>
			)}
			<p className="text-xs text-muted-foreground">
				{m.import_apply_retention()}
			</p>
			{error === "status" ? (
				<Button
					variant="outline"
					disabled={disabled}
					onClick={() => setReload((value) => value + 1)}
				>
					{m.import_apply_retry_status()}
				</Button>
			) : applying ? (
				<Button
					variant="outline"
					onClick={() => {
						active.current?.abort();
						setPaused(true);
					}}
				>
					{m.import_apply_pause()}
				</Button>
			) : (
				<Button
					disabled={
						!supported || disabled || loading || terminal || counts.ensure === 0
					}
					onClick={() => void apply()}
				>
					{run || approved.current
						? m.import_apply_resume()
						: m.import_apply_action()}
				</Button>
			)}
		</div>
	);
}
