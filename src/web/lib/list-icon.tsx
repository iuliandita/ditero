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
import { m } from "../../paraglide/messages.js";
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

// What each glyph DEPICTS, not what lucide calls it: the picker previously
// announced the raw id, so "folder-kanban" and "gamepad-2" reached screen
// readers verbatim and in English regardless of locale. Thunks, not calls:
// a resolved string here would freeze the import-time locale.
// Kept beside ICONS so the two stay in sync (list-icon.test.ts asserts it).
const ICON_LABELS: Record<string, () => string> = {
	check: m.icon_label_check,
	"list-checks": m.icon_label_list_checks,
	"folder-kanban": m.icon_label_folder_kanban,
	repeat: m.icon_label_repeat,
	"shopping-basket": m.icon_label_shopping_basket,
	"shopping-cart": m.icon_label_shopping_cart,
	dumbbell: m.icon_label_dumbbell,
	plane: m.icon_label_plane,
	pill: m.icon_label_pill,
	"paw-print": m.icon_label_paw_print,
	"book-open": m.icon_label_book_open,
	briefcase: m.icon_label_briefcase,
	house: m.icon_label_house,
	cake: m.icon_label_cake,
	clapperboard: m.icon_label_clapperboard,
	"spray-can": m.icon_label_spray_can,
	car: m.icon_label_car,
	sprout: m.icon_label_sprout,
	music: m.icon_label_music,
	code: m.icon_label_code,
	phone: m.icon_label_phone,
	mail: m.icon_label_mail,
	wallet: m.icon_label_wallet,
	droplet: m.icon_label_droplet,
	star: m.icon_label_star,
	heart: m.icon_label_heart,
	flag: m.icon_label_flag,
	bell: m.icon_label_bell,
	calendar: m.icon_label_calendar,
	clock: m.icon_label_clock,
	coffee: m.icon_label_coffee,
	utensils: m.icon_label_utensils,
	pizza: m.icon_label_pizza,
	apple: m.icon_label_apple,
	carrot: m.icon_label_carrot,
	gift: m.icon_label_gift,
	camera: m.icon_label_camera,
	"gamepad-2": m.icon_label_gamepad_2,
	headphones: m.icon_label_headphones,
	palette: m.icon_label_palette,
	scissors: m.icon_label_scissors,
	hammer: m.icon_label_hammer,
	wrench: m.icon_label_wrench,
	lightbulb: m.icon_label_lightbulb,
	cloud: m.icon_label_cloud,
	sun: m.icon_label_sun,
	moon: m.icon_label_moon,
	umbrella: m.icon_label_umbrella,
	flame: m.icon_label_flame,
	leaf: m.icon_label_leaf,
	flower: m.icon_label_flower,
	trees: m.icon_label_trees,
	mountain: m.icon_label_mountain,
	tent: m.icon_label_tent,
	bike: m.icon_label_bike,
	bus: m.icon_label_bus,
	ship: m.icon_label_ship,
	"map-pin": m.icon_label_map_pin,
	compass: m.icon_label_compass,
	"graduation-cap": m.icon_label_graduation_cap,
	pencil: m.icon_label_pencil,
	"clipboard-list": m.icon_label_clipboard_list,
	"calendar-check": m.icon_label_calendar_check,
	target: m.icon_label_target,
	rocket: m.icon_label_rocket,
	anchor: m.icon_label_anchor,
	baby: m.icon_label_baby,
	dog: m.icon_label_dog,
	cat: m.icon_label_cat,
	fish: m.icon_label_fish,
	bird: m.icon_label_bird,
};

// Falls back to the raw key rather than throwing: an unnamed icon should still
// be pickable, just poorly announced. Object.hasOwn for the same reason ListIcon
// uses it -- the key can reach here from stored data.
export function iconLabel(name: string): string {
	return Object.hasOwn(ICON_LABELS, name) ? ICON_LABELS[name]() : name;
}

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
	// Object.hasOwn guards the client-controlled key: a prototype key
	// ("constructor"/"__proto__") must not resolve to a non-component via the
	// prototype chain and crash the render.
	const Icon = Object.hasOwn(ICONS, name) ? ICONS[name] : undefined;
	// A stored icon that is not a registry key is an emoji chosen in the picker;
	// render it as a glyph rather than the fallback list mark.
	if (!Icon && icon && !Object.hasOwn(ICONS, icon)) {
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
