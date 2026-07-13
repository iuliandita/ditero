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
			<main className="pb-24 md:pb-0">
				<div className="mx-auto w-full 2xl:max-w-[1200px]">{children}</div>
			</main>
			<div className="md:hidden">
				{fab}
				{bottomNav}
			</div>
		</div>
	);
}
