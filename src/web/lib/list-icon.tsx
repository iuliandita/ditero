import {
	BookOpen,
	Briefcase,
	Cake,
	Car,
	Check,
	Clapperboard,
	Code,
	Droplet,
	Dumbbell,
	FolderKanban,
	House,
	ListChecks,
	List as ListFallback,
	type LucideIcon,
	Mail,
	Music,
	PawPrint,
	Phone,
	Pill,
	Plane,
	Repeat,
	ShoppingBasket,
	ShoppingCart,
	SprayCan,
	Sprout,
	Wallet,
} from "lucide-react";
import type { ListKind } from "../../domain/icon-map.ts";
import { suggestIcon } from "../../domain/icon-map.ts";
import { cn } from "./utils.ts";

// Curated map of the kebab-case names icon-map.ts can emit, so we import only
// the icons we use instead of pulling lucide's full set into the bundle.
const ICONS: Record<string, LucideIcon> = {
	check: Check,
	"shopping-basket": ShoppingBasket,
	"list-checks": ListChecks,
	"folder-kanban": FolderKanban,
	repeat: Repeat,
	"shopping-cart": ShoppingCart,
	dumbbell: Dumbbell,
	plane: Plane,
	pill: Pill,
	"paw-print": PawPrint,
	"book-open": BookOpen,
	briefcase: Briefcase,
	house: House,
	cake: Cake,
	clapperboard: Clapperboard,
	"spray-can": SprayCan,
	car: Car,
	sprout: Sprout,
	music: Music,
	code: Code,
	phone: Phone,
	mail: Mail,
	wallet: Wallet,
	droplet: Droplet,
};

// Per-kind accent token (index.css --color-kind-*). habits has no token (it is
// a hidden kind) so it falls back to the neutral foreground.
const KIND_ACCENT: Record<ListKind, string> = {
	tasks: "text-kind-tasks",
	shopping: "text-kind-shopping",
	checklist: "text-kind-checklist",
	project: "text-kind-project",
	habits: "text-muted-foreground",
};

export function kindAccentClass(kind: ListKind): string {
	return KIND_ACCENT[kind];
}

export function ListIcon({
	icon,
	kind,
	title,
	className,
}: {
	icon?: string | null;
	kind: ListKind;
	title: string;
	className?: string;
}) {
	const name = icon ?? suggestIcon(title, kind);
	const Icon = ICONS[name] ?? ListFallback;
	return (
		<Icon
			aria-hidden
			className={cn("size-4", kindAccentClass(kind), className)}
		/>
	);
}
