import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getLocale } from "../paraglide/runtime.js";
import { App } from "./App.tsx";
import { applyDocumentLocale } from "./lib/locale.ts";
import { applyTheme, readLocalTheme } from "./lib/theme.ts";

applyDocumentLocale(getLocale());
applyTheme(readLocalTheme(), document.documentElement);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
