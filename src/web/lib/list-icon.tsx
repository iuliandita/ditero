import {
	Anchor,
	Apple,
	Baby,
	Bell,
	Bike,
	Bird,
	BookOpen,
	Briefcase,
	Bus,
	Cake,
	Calendar,
	CalendarCheck,
	Camera,
	Car,
	Carrot,
	Cat,
	Check,
	Clapperboard,
	ClipboardList,
	Clock,
	Cloud,
	Code,
	Coffee,
	Compass,
	Dog,
	Droplet,
	Dumbbell,
	Fish,
	Flag,
	Flame,
	Flower,
	FolderKanban,
	Gamepad2,
	Gift,
	GraduationCap,
	Hammer,
	Headphones,
	Heart,
	House,
	Leaf,
	Lightbulb,
	ListChecks,
	List as ListFallback,
	type LucideIcon,
	Mail,
	MapPin,
	Moon,
	Mountain,
	Music,
	Palette,
	PawPrint,
	Pencil,
	Phone,
	Pill,
	Pizza,
	Plane,
	Repeat,
	Rocket,
	Scissors,
	Ship,
	ShoppingBasket,
	ShoppingCart,
	SprayCan,
	Sprout,
	Star,
	Sun,
	Target,
	Tent,
	Trees,
	Umbrella,
	Utensils,
	Wallet,
	Wrench,
} from "lucide-react";
import type { ListKind } from "../../domain/icon-map.ts";
import { suggestIcon } from "../../domain/icon-map.ts";
import { cn } from "./utils.ts";

// Curated registry shared by the sidebar/list rendering and the IconPicker. The
// kebab keys are the names icon-map.ts emits plus a wider set the picker offers;
// importing named icons keeps lucide's full set out of the bundle.
export const ICONS: Record<string, LucideIcon> = {
	check: Check,
	"list-checks": ListChecks,
	"folder-kanban": FolderKanban,
	repeat: Repeat,
	"shopping-basket": ShoppingBasket,
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
	star: Star,
	heart: Heart,
	flag: Flag,
	bell: Bell,
	calendar: Calendar,
	clock: Clock,
	coffee: Coffee,
	utensils: Utensils,
	pizza: Pizza,
	apple: Apple,
	carrot: Carrot,
	gift: Gift,
	camera: Camera,
	"gamepad-2": Gamepad2,
	headphones: Headphones,
	palette: Palette,
	scissors: Scissors,
	hammer: Hammer,
	wrench: Wrench,
	lightbulb: Lightbulb,
	cloud: Cloud,
	sun: Sun,
	moon: Moon,
	umbrella: Umbrella,
	flame: Flame,
	leaf: Leaf,
	flower: Flower,
	trees: Trees,
	mountain: Mountain,
	tent: Tent,
	bike: Bike,
	bus: Bus,
	ship: Ship,
	"map-pin": MapPin,
	compass: Compass,
	"graduation-cap": GraduationCap,
	pencil: Pencil,
	"clipboard-list": ClipboardList,
	"calendar-check": CalendarCheck,
	target: Target,
	rocket: Rocket,
	anchor: Anchor,
	baby: Baby,
	dog: Dog,
	cat: Cat,
	fish: Fish,
	bird: Bird,
};

export const ICON_NAMES = Object.keys(ICONS);

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
	const Icon = ICONS[name];
	// A stored icon that is not a registry key is an emoji chosen in the picker;
	// render it as a glyph rather than the fallback list mark.
	if (!Icon && icon && !ICONS[icon]) {
		return (
			<span aria-hidden className={cn("text-base leading-none", className)}>
				{icon}
			</span>
		);
	}
	const Resolved = Icon ?? ListFallback;
	return (
		<Resolved
			aria-hidden
			className={cn("size-4", kindAccentClass(kind), className)}
		/>
	);
}
