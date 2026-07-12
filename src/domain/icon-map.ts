import type { listKindEnum } from "../db/schema.ts";

// Derived from the Drizzle enum (single source of truth). Type-only import is
// fully erased under verbatimModuleSyntax, so no drizzle runtime reaches this
// client+server module.
export type ListKind = (typeof listKindEnum.enumValues)[number];

const KIND_DEFAULT: Record<ListKind, string> = {
	tasks: "check",
	shopping: "shopping-basket",
	checklist: "list-checks",
	project: "folder-kanban",
	habits: "repeat",
};

// lucide-react icon names (kebab-case); verified present in node_modules/lucide-react.
// Document order = match priority (first hit wins).
const KEYWORDS: [RegExp, string][] = [
	[/groceries|market/i, "shopping-cart"],
	[/gym|workout/i, "dumbbell"],
	[/trip|travel/i, "plane"],
	[/meds|pills?/i, "pill"],
	[/dog|pet/i, "paw-print"],
	[/book|read/i, "book-open"],
	[/work/i, "briefcase"],
	[/home/i, "house"],
	[/birthday/i, "cake"],
	[/movie/i, "clapperboard"],
	[/clean/i, "spray-can"],
	[/car/i, "car"],
	[/plant|garden/i, "sprout"],
	[/music/i, "music"],
	[/code/i, "code"],
	[/call|phone/i, "phone"],
	[/email/i, "mail"],
	[/money|pay/i, "wallet"],
	[/water/i, "droplet"],
];

export function suggestIcon(title: string, kind: ListKind): string {
	for (const [re, icon] of KEYWORDS) {
		if (re.test(title)) return icon;
	}
	return KIND_DEFAULT[kind];
}
