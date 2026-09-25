import { useEffect, useRef, useState } from "react";
import { m } from "../../../paraglide/messages.js";
import { Button } from "../ui/button.tsx";

export function DataPortabilityPanel() {
	const active = useRef<AbortController | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<"failed" | "limit" | "history" | null>(
		null,
	);
	useEffect(() => () => active.current?.abort(), []);

	async function download() {
		if (active.current) return;
		const controller = new AbortController();
		active.current = controller;
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/portability/export", {
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
			link.download = "ditero-export-v1.json";
			link.click();
			// Allow the browser to begin consuming the download before releasing it.
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch {
			if (!controller.signal.aborted) setError("failed");
		} finally {
			if (active.current === controller) {
				active.current = null;
				if (!controller.signal.aborted) setBusy(false);
			}
		}
	}

	return (
		<section
			id="data-portability"
			className="mt-8 border-t pt-4"
			aria-labelledby="data-portability-heading"
		>
			<h2 id="data-portability-heading" className="text-sm font-semibold">
				{m.portability_heading()}
			</h2>
			<p className="mt-1 text-xs text-muted-foreground">
				{m.portability_description()}
			</p>
			<p className="mt-2 text-xs text-muted-foreground">
				{m.portability_boundary()}
			</p>
			<Button
				className="mt-3"
				variant="outline"
				disabled={busy}
				onClick={() => void download()}
			>
				{busy ? m.portability_exporting() : m.portability_download()}
			</Button>
			{error && (
				<p role="alert" className="mt-2 text-sm text-destructive">
					{error === "limit"
						? m.portability_limit()
						: error === "history"
							? m.portability_history_requires_v2()
							: m.portability_failed()}
				</p>
			)}
		</section>
	);
}
