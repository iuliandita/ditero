import { useEffect, useRef, useState } from "react";
import { m } from "../../../paraglide/messages.js";
import { useExportBoundary } from "../../lib/zero.tsx";
import { Button } from "../ui/button.tsx";

export function DataPortabilityPanel() {
	const boundary = useExportBoundary();
	const active = useRef<AbortController | null>(null);
	const [busy, setBusy] = useState(false);
	const [waiting, setWaiting] = useState(false);
	const [error, setError] = useState<"failed" | "limit" | "pending" | null>(
		null,
	);
	useEffect(() => () => active.current?.abort(), []);

	async function download(savedSnapshotOnly = false) {
		if (active.current) return;
		const controller = new AbortController();
		active.current = controller;
		setBusy(true);
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
			const response = await fetch("/api/portability/export", {
				credentials: "same-origin",
				signal: controller.signal,
			});
			if (response.status === 413) {
				setError("limit");
				return;
			}
			if (!response.ok) throw new Error("Export failed");
			const blob = await response.blob();
			if (controller.signal.aborted) return;
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = "ditero-export-v1.json";
			link.click();
			// Allow the browser to begin consuming the download before releasing it.
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch {
			if (!controller.signal.aborted) setError("failed");
		} finally {
			if (active.current === controller) {
				active.current = null;
				setWaiting(false);
				if (!controller.signal.aborted) setBusy(false);
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
				className="mt-3"
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
			{error && (
				<p role="alert" className="mt-2 text-sm text-destructive">
					{error === "pending"
						? m.portability_pending()
						: error === "limit"
							? m.portability_limit()
							: m.portability_failed()}
				</p>
			)}
			{error === "pending" && (
				<Button
					className="mt-2"
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
