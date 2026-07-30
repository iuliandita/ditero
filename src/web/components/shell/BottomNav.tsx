import { List, Search, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";

export type Section = "lists" | "settings";

// Mobile bottom tab bar: exactly three destinations. Search is present but
// disabled until M1c. Fixed to the bottom edge; 44px+ touch targets.
export function BottomNav({
	section,
	onSection,
}: {
	section: Section;
	onSection: (section: Section) => void;
}) {
	return (
		<nav
			aria-label={m.nav_primary_label()}
			className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] supports-backdrop-filter:bg-background/80 supports-backdrop-filter:backdrop-blur"
		>
			<Tab
				testId="nav-tab-lists"
				label={m.nav_lists()}
				active={section === "lists"}
				onClick={() => onSection("lists")}
			>
				<List className="size-5" />
			</Tab>
			<Tab
				testId="nav-tab-search"
				label={m.nav_search()}
				disabled
				title={m.nav_search_disabled_hint()}
			>
				<Search className="size-5" />
			</Tab>
			<Tab
				testId="nav-tab-settings"
				label={m.nav_settings()}
				active={section === "settings"}
				onClick={() => onSection("settings")}
			>
				<Settings className="size-5" />
			</Tab>
		</nav>
	);
}

function Tab({
	testId,
	label,
	active,
	disabled,
	title,
	onClick,
	children,
}: {
	// A tab's only text is its translated label, so locating one by name is both
	// locale-bound and ambiguous: an unscoped "Settings" also substring-matches
	// the keymap surface's "Rebind Open settings" button (#64).
	testId: string;
	label: string;
	active?: boolean;
	disabled?: boolean;
	title?: string;
	onClick?: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			data-testid={testId}
			// aria-disabled (not the native attribute) keeps the tab focusable and
			// announced so a placeholder destination stays discoverable.
			aria-disabled={disabled || undefined}
			title={title}
			aria-current={active ? "page" : undefined}
			onClick={disabled ? undefined : onClick}
			className={cn(
				"flex min-h-[44px] flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium transition-colors",
				active ? "text-foreground" : "text-muted-foreground",
				disabled ? "opacity-40" : "hover:text-foreground active:bg-muted/60",
			)}
		>
			{children}
			<span>{label}</span>
		</button>
	);
}
