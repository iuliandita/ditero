import "../../android/src/native.css";
import { createRoot } from "react-dom/client";
import { m } from "../../../src/paraglide/messages.js";
import { getLocale } from "../../../src/paraglide/runtime.js";
import { BootSkeleton } from "../../../src/web/components/shell/AppSkeleton.tsx";
import { Button } from "../../../src/web/components/ui/button.tsx";
import { applyDocumentLocale } from "../../../src/web/lib/locale.ts";
import { applyTheme, readLocalTheme } from "../../../src/web/lib/theme.ts";
import { installTransport } from "./transport.ts";

applyDocumentLocale(getLocale());
applyTheme(readLocalTheme(), document.documentElement);
const element = document.getElementById("root");
if (!element) throw new Error("missing #root");
const root = createRoot(element);
root.render(<BootSkeleton />);
try {
	await installTransport();
	const { NativeApp } = await import("../../android/src/NativeApp.tsx");
	root.render(<NativeApp />);
} catch (error) {
	console.error("Desktop startup failed", error);
	root.render(
		<main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6">
			<p role="alert">{m.native_signin_failed()}</p>
			<Button onClick={() => window.location.reload()}>
				{m.action_retry()}
			</Button>
		</main>,
	);
}
