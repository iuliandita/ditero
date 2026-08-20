import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getLocale } from "../paraglide/runtime.js";
import { App } from "./App.tsx";
import { installCryptoVectorHarness } from "./dev/crypto-vectors.ts";
import { applyDocumentLocale } from "./lib/locale.ts";
import { applyTheme, readLocalTheme } from "./lib/theme.ts";

applyDocumentLocale(getLocale());
applyTheme(readLocalTheme(), document.documentElement);
// No-op outside dev and test; see the guard in dev/crypto-vectors.ts.
installCryptoVectorHarness();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
