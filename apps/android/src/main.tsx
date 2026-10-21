import "./native.css";
import { createRoot } from "react-dom/client";
import { getLocale } from "../../../src/paraglide/runtime.js";
import { applyDocumentLocale } from "../../../src/web/lib/locale.ts";
import { installNativeBack } from "../../../src/web/lib/native-back.ts";
import { applyTheme, readLocalTheme } from "../../../src/web/lib/theme.ts";
import { NativeApp } from "./NativeApp.tsx";

installNativeBack();
applyDocumentLocale(getLocale());
applyTheme(readLocalTheme(), document.documentElement);
const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<NativeApp />);
