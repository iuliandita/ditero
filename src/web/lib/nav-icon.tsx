import {
	CalendarDays,
	Folder,
	Inbox,
	LayoutDashboard,
	ListFilter,
	type LucideIcon,
	SquareKanban,
	Sun,
	Table2,
	UserCheck,
} from "lucide-react";
import type { ViewLayout } from "../../domain/view-filter.ts";
import { ICONS } from "./list-icon.tsx";

// Navigation glyphs by item type, so a view, a dashboard, a folder and a list
// never share the generic list mark. Lists keep their per-kind icon (ListIcon).
const BUILTIN: Record<string, LucideIcon> = {
	today: Sun,
	"all-my-tasks": Inbox,
	"assigned-to-me": UserCheck,
};

const LAYOUT: Record<ViewLayout, LucideIcon> = {
	list: ListFilter,
	board: SquareKanban,
	table: Table2,
	calendar: CalendarDays,
};

export const FolderIcon = Folder;

// A picked icon wins; otherwise the layout names what the view looks like.
// Object.hasOwn: both keys arrive from synced rows a co-member can write.
export function viewIcon(view: {
	id: string;
	icon?: string | null;
	display?: { layout?: string } | null;
}): LucideIcon {
	if (Object.hasOwn(BUILTIN, view.id)) return BUILTIN[view.id];
	if (view.icon && Object.hasOwn(ICONS, view.icon)) return ICONS[view.icon];
	const layout = view.display?.layout;
	if (layout && Object.hasOwn(LAYOUT, layout))
		return LAYOUT[layout as ViewLayout];
	return ListFilter;
}

export function dashboardIcon(dashboard: { icon?: string | null }): LucideIcon {
	const icon = dashboard.icon;
	return icon && Object.hasOwn(ICONS, icon) ? ICONS[icon] : LayoutDashboard;
}
