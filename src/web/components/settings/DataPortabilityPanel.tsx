import { useEffect, useRef, useState } from "react";
import { m } from "../../../paraglide/messages.js";
import { useExportBoundary } from "../../lib/zero.tsx";
import { Button } from "../ui/button.tsx";

export function DataPortabilityPanel() {
	const boundary = useExportBoundary();
	const active = useRef<AbortController | null>(null);
	const downloadButton = useRef<HTMLButtonElement | null>(null);
	const fallbackButton = useRef<HTMLButtonElement | null>(null);
	const restoreFocus = useRef(false);
	const [busy, setBusy] = useState(false);
	const [waiting, setWaiting] = useState(false);
	const [requested, setRequested] = useState(false);
	const [savedSnapshotBusy, setSavedSnapshotBusy] = useState(false);
	const [error, setError] = useState<
		"failed" | "limit" | "pending" | "history" | null
	>(null);
	useEffect(() => () => active.current?.abort(), []);

	useEffect(() => {
		if (!busy && restoreFocus.current) {
			restoreFocus.current = false;
			if (document.activeElement === document.body)
				downloadButton.current?.focus();
		}
	}, [busy]);

	async function download(savedSnapshotOnly = false) {
		if (active.current) return;
		const controller = new AbortController();
		active.current = controller;
		restoreFocus.current =
			savedSnapshotOnly && document.activeElement === fallbackButton.current;
		setBusy(true);
		setSavedSnapshotBusy(savedSnapshotOnly);
		setRequested(false);
		setError(null);
		try {
			if (!savedSnapshotOnly) {
				setWaiting(true);
				const saved = await boundary.waitForSaved({
					signal: controller.signal,
				});
				if (controller.signal.aborted) return;
				boundary.refreshJournal();
				const state = boundary.getSnapshot();
				if (
					!saved ||
					state.pending > 0 ||
					state.uncertain ||
					state.refused ||
					state.prior ||
					state.storageFailed
				) {
					setError("pending");
					return;
				}
			}
			setWaiting(false);
			const response = await fetch("/api/portability/export?version=2", {
				credentials: "same-origin",
				signal: controller.signal,
			});
			if (response.status === 413) {
				setError("limit");
				return;
			}
			if (response.status === 409) {
				const body: unknown = await response.json().catch(() => null);
				if (
					body != null &&
					typeof body === "object" &&
					"code" in body &&
					body.code === "history-requires-v2"
				) {
					setError("history");
					return;
				}
			}
			if (!response.ok) throw new Error("Export failed");
			const blob = await response.blob();
			if (controller.signal.aborted) return;
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = "ditero-history-v2.json";
			link.click();
			setRequested(true);
			// Allow the browser to begin consuming the download before releasing it.
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch {
			if (!controller.signal.aborted) setError("failed");
		} finally {
			if (active.current === controller) {
				active.current = null;
				setWaiting(false);
				if (!controller.signal.aborted) {
					setBusy(false);
					setSavedSnapshotBusy(false);
				}
			}
		}
	}

	return (
		<section id="data-portability" aria-labelledby="data-portability-heading">
			<h3 id="data-portability-heading" className="text-sm font-semibold">
				{m.portability_heading()}
			</h3>
			<p className="mt-1 text-xs text-muted-foreground">
				{m.portability_description()}
			</p>
			<p className="mt-2 text-xs text-muted-foreground">
				{m.portability_boundary()}
			</p>
			<p className="mt-2 text-xs text-muted-foreground">
				{m.portability_saved_boundary()}
			</p>
			<Button
				ref={downloadButton}
				className="mt-3 h-auto min-h-8 max-w-full whitespace-normal py-1.5 pointer-coarse:min-h-11"
				variant="outline"
				disabled={busy}
				onClick={() => void download()}
			>
				{waiting
					? m.portability_waiting()
					: busy
						? m.portability_exporting()
						: m.portability_download()}
			</Button>
			<p
				role="status"
				aria-live="polite"
				className="mt-2 text-xs text-muted-foreground"
			>
				{waiting
					? m.portability_waiting()
					: busy
						? m.portability_exporting()
						: requested
							? m.portability_download_requested()
							: null}
			</p>
			{error && (
				<p role="alert" className="mt-2 text-sm text-destructive">
					{error === "pending"
						? m.portability_pending()
						: error === "limit"
							? m.portability_limit()
							: error === "history"
								? m.portability_history_requires_v2()
								: m.portability_failed()}
				</p>
			)}
			{(error === "pending" || savedSnapshotBusy) && (
				<Button
					ref={fallbackButton}
					className="mt-2 h-auto min-h-8 max-w-full whitespace-normal py-1.5 pointer-coarse:min-h-11"
					variant="outline"
					disabled={busy}
					onClick={() => void download(true)}
				>
					{m.portability_saved_anyway()}
				</Button>
			)}
		</section>
	);
}
