import { List, Search, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";

export type Section = "lists" | "settings";
export type MobileTab = "today" | "lists";

// Mobile bottom tab bar: three destinations, so each stays a wide thumb target.
// Settings is not a tab: it is an occasional destination and lives in the
// workspace switcher at the top of Today and Lists. Search opens an overlay
// rather than switching tabs, so it never carries aria-current.
export function BottomNav({
	tab,
	onTab,
	onSearch,
}: {
	tab: MobileTab | null;
	onTab: (tab: MobileTab) => void;
	onSearch: () => void;
}) {
	return (
		<nav
			aria-label={m.nav_primary_label()}
			className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t bg-background pb-[env(safe-area-inset-bottom)]"
		>
			<Tab
				testId="nav-tab-today"
				label={m.builtin_view_today()}
				active={tab === "today"}
				onClick={() => onTab("today")}
			>
				<Sun className="size-5" />
			</Tab>
			<Tab
				testId="nav-tab-lists"
				label={m.nav_lists()}
				active={tab === "lists"}
				onClick={() => onTab("lists")}
			>
				<List className="size-5" />
			</Tab>
			<Tab testId="nav-tab-search" label={m.nav_search()} onClick={onSearch}>
				<Search className="size-5" />
			</Tab>
		</nav>
	);
}

function Tab({
	testId,
	label,
	active,
	onClick,
	children,
}: {
	// A tab's only text is its translated label, so locating one by name is both
	// locale-bound and ambiguous: an unscoped "Settings" also substring-matches
	// the keymap surface's "Rebind Open settings" button (#64).
	testId: string;
	label: string;
	active?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			data-testid={testId}
			aria-current={active ? "page" : undefined}
			onClick={onClick}
			className={cn(
				"flex min-h-[44px] flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium transition-colors duration-(--motion-fast) ease-(--motion-ease) hover:text-foreground active:bg-muted/60",
				active ? "text-foreground" : "text-muted-foreground",
			)}
		>
			{children}
			<span>{label}</span>
		</button>
	);
}
