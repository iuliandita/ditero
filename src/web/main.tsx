import "./index.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import * as m from "../paraglide/messages.js";
import { getLocale } from "../paraglide/runtime.js";
import { App } from "./App.tsx";
import { installCryptoVectorHarness } from "./dev/crypto-vectors.ts";
import {
	applyDisplayPreferences,
	DEFAULT_DISPLAY_PREFERENCES,
} from "./lib/display-preferences.ts";
import { applyDocumentLocale } from "./lib/locale.ts";
import { activatePwaUpdate, registerPwa } from "./lib/pwa.ts";
import { applyTheme, readLocalTheme } from "./lib/theme.ts";
import { retireZeroClients } from "./lib/zero-lifecycle.ts";

applyDocumentLocale(getLocale());
applyTheme(readLocalTheme(), document.documentElement);
applyDisplayPreferences(DEFAULT_DISPLAY_PREFERENCES, document.documentElement);
// No-op outside dev and test; see the guard in dev/crypto-vectors.ts.
installCryptoVectorHarness();

function PwaUpdate() {
	const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (!import.meta.env.PROD || import.meta.env.MODE === "test") return;
		let mounted = true;
		void registerPwa((worker) => {
			if (mounted) setWaiting(worker);
		}).catch((error: unknown) =>
			console.error("PWA registration failed", error),
		);
		return () => {
			mounted = false;
		};
	}, []);
	if (!waiting) return null;
	return (
		<aside
			role="status"
			className="fixed bottom-4 start-4 end-4 z-50 mx-auto max-w-md rounded-lg border bg-background p-4 text-foreground shadow-lg"
		>
			<p>{failed ? m.sync_save_pending_failed() : m.pwa_update_available()}</p>
			<div className="mt-3 flex gap-3">
				<button
					type="button"
					disabled={busy}
					className="rounded border px-3 py-2"
					onClick={() => {
						setBusy(true);
						setFailed(false);
						void activatePwaUpdate(
							waiting,
							() => retireZeroClients(),
							navigator.serviceWorker,
							() => window.location.reload(),
						).catch(() => {
							setBusy(false);
							setFailed(true);
						});
					}}
				>
					{m.native_authorize_reload()}
				</button>
				<button
					type="button"
					disabled={busy}
					className="rounded border px-3 py-2"
					onClick={() => setWaiting(null)}
				>
					{m.sync_rejected_dismiss()}
				</button>
			</div>
		</aside>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
	<StrictMode>
		<App />
		<PwaUpdate />
	</StrictMode>,
);
