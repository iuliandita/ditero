import { List, Search, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

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
			aria-label="Primary"
			className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] supports-backdrop-filter:bg-background/80 supports-backdrop-filter:backdrop-blur"
		>
			<Tab
				label="Lists"
				active={section === "lists"}
				onClick={() => onSection("lists")}
			>
				<List className="size-5" />
			</Tab>
			<Tab label="Search" disabled title="Search — coming soon">
				<Search className="size-5" />
			</Tab>
			<Tab
				label="Settings"
				active={section === "settings"}
				onClick={() => onSection("settings")}
			>
				<Settings className="size-5" />
			</Tab>
		</nav>
	);
}

function Tab({
	label,
	active,
	disabled,
	title,
	onClick,
	children,
}: {
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
