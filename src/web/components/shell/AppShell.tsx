import type { ReactNode } from "react";

// Responsive frame with a single breakpoint switch at md (768px). Below md:
// content + fixed bottom nav + fab. At/above md: persistent sidebar + content
// pane. The `workspace` testid is the stable app-root the spine e2e waits on.
export function AppShell({
	sidebar,
	bottomNav,
	fab,
	children,
}: {
	sidebar: ReactNode;
	bottomNav: ReactNode;
	fab: ReactNode;
	children: ReactNode;
}) {
	return (
		<div
			data-testid="workspace"
			className="min-h-dvh md:grid md:grid-cols-[auto_1fr]"
		>
			<div className="hidden md:block">{sidebar}</div>
			{/* Room below the last row for the tab bar, the floating add button
			    (top edge ~136px up) and the snackbar that stacks above it. */}
			<main className="pb-[calc(11rem+env(safe-area-inset-bottom))] md:pb-0">
				<div className="mx-auto w-full md:max-w-[1200px]">{children}</div>
			</main>
			<div className="md:hidden">
				{fab}
				{bottomNav}
			</div>
		</div>
	);
}
