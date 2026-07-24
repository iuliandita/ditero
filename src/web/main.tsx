import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getLocale } from "../paraglide/runtime.js";
import { App } from "./App.tsx";
import { applyDocumentLocale } from "./lib/locale.ts";

applyDocumentLocale(getLocale());

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
