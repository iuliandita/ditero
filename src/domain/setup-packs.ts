import { z } from "zod";
import {
	ACCOUNT_SETUP_CATALOG_VERSION,
	type ACCOUNT_SETUP_STARTERS,
} from "./account-setup.ts";
import { LOCALES, type Locale } from "./locale.ts";
import { type TemplateTask, templateContentSchema } from "./template.ts";

type StarterKey = (typeof ACCOUNT_SETUP_STARTERS)[number];
type Labels = {
	packTitles: readonly [string, string, string];
	dashboardTitles: readonly [string, string, string];
	shopping: readonly [
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
	];
	categories: readonly [string, string, string, string, string];
	packing: readonly [
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
	];
	cleaning: readonly [
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
	];
};
const labels: Record<Locale, Labels> = {
	en: {
		packTitles: ["Shopping", "Packing", "Cleaning"],
		dashboardTitles: ["My day", "Open tasks", "Overdue"],
		shopping: [
			"Milk",
			"Eggs",
			"Bread",
			"Bananas",
			"Spinach",
			"Chicken breast",
			"Rice",
			"Coffee",
		],
		categories: ["Dairy", "Bakery", "Produce", "Meat", "Pantry"],
		packing: [
			"Passport / ID",
			"Phone charger",
			"Toiletries",
			"Medications",
			"Chargers & adapters",
			"Underwear & socks",
			"Water bottle",
			"Headphones",
		],
		cleaning: [
			"Vacuum floors",
			"Take out trash & recycling",
			"Clean bathroom",
			"Change bed sheets",
			"Do laundry",
			"Wipe kitchen counters",
			"Water plants",
			"Grocery run",
		],
	},
	de: {
		packTitles: ["Einkaufen", "Packen", "Putzen"],
		dashboardTitles: ["Mein Tag", "Offene Aufgaben", "Überfällig"],
		shopping: [
			"Milch",
			"Eier",
			"Brot",
			"Bananen",
			"Spinat",
			"Hähnchenbrust",
			"Reis",
			"Kaffee",
		],
		categories: [
			"Milchprodukte",
			"Backwaren",
			"Obst und Gemüse",
			"Fleisch",
			"Vorräte",
		],
		packing: [
			"Reisepass / Ausweis",
			"Handyladegerät",
			"Kulturbeutel",
			"Medikamente",
			"Ladegeräte & Adapter",
			"Unterwäsche & Socken",
			"Wasserflasche",
			"Kopfhörer",
		],
		cleaning: [
			"Böden saugen",
			"Müll und Recycling rausbringen",
			"Bad putzen",
			"Bettwäsche wechseln",
			"Wäsche waschen",
			"Küchenarbeitsflächen abwischen",
			"Pflanzen gießen",
			"Lebensmittel einkaufen",
		],
	},
	es: {
		packTitles: ["Compras", "Equipaje", "Limpieza"],
		dashboardTitles: ["Mi día", "Tareas pendientes", "Atrasadas"],
		shopping: [
			"Leche",
			"Huevos",
			"Pan",
			"Plátanos",
			"Espinacas",
			"Pechuga de pollo",
			"Arroz",
			"Café",
		],
		categories: [
			"Lácteos",
			"Panadería",
			"Frutas y verduras",
			"Carne",
			"Despensa",
		],
		packing: [
			"Pasaporte / documento de identidad",
			"Cargador del móvil",
			"Artículos de aseo",
			"Medicamentos",
			"Cargadores y adaptadores",
			"Ropa interior y calcetines",
			"Botella de agua",
			"Auriculares",
		],
		cleaning: [
			"Aspirar los suelos",
			"Sacar la basura y el reciclaje",
			"Limpiar el baño",
			"Cambiar las sábanas",
			"Lavar la ropa",
			"Limpiar las encimeras de la cocina",
			"Regar las plantas",
			"Comprar alimentos",
		],
	},
	fr: {
		packTitles: ["Courses", "Bagages", "Ménage"],
		dashboardTitles: ["Ma journée", "Tâches à faire", "En retard"],
		shopping: [
			"Lait",
			"Œufs",
			"Pain",
			"Bananes",
			"Épinards",
			"Blanc de poulet",
			"Riz",
			"Café",
		],
		categories: [
			"Produits laitiers",
			"Boulangerie",
			"Fruits et légumes",
			"Viande",
			"Épicerie",
		],
		packing: [
			"Passeport / carte d’identité",
			"Chargeur de téléphone",
			"Affaires de toilette",
			"Médicaments",
			"Chargeurs et adaptateurs",
			"Sous-vêtements et chaussettes",
			"Bouteille d’eau",
			"Casque audio",
		],
		cleaning: [
			"Passer l’aspirateur",
			"Sortir les poubelles et le recyclage",
			"Nettoyer la salle de bain",
			"Changer les draps",
			"Faire la lessive",
			"Essuyer les plans de travail",
			"Arroser les plantes",
			"Faire les courses",
		],
	},
	ro: {
		packTitles: ["Cumpărături", "Bagaje", "Curățenie"],
		dashboardTitles: ["Ziua mea", "Sarcini de făcut", "Întârziate"],
		shopping: [
			"Lapte",
			"Ouă",
			"Pâine",
			"Banane",
			"Spanac",
			"Piept de pui",
			"Orez",
			"Cafea",
		],
		categories: [
			"Lactate",
			"Panificație",
			"Fructe și legume",
			"Carne",
			"Alimente de bază",
		],
		packing: [
			"Pașaport / act de identitate",
			"Încărcător de telefon",
			"Articole de igienă",
			"Medicamente",
			"Încărcătoare și adaptoare",
			"Lenjerie și șosete",
			"Sticlă de apă",
			"Căști",
		],
		cleaning: [
			"Aspiră podelele",
			"Du gunoiul și materialele reciclabile",
			"Curăță baia",
			"Schimbă lenjeria de pat",
			"Spală rufele",
			"Șterge blaturile din bucătărie",
			"Udă plantele",
			"Cumpără alimente",
		],
	},
	ar: {
		packTitles: ["التسوق", "تجهيز الأمتعة", "التنظيف"],
		dashboardTitles: ["يومي", "المهام المفتوحة", "متأخرة"],
		shopping: ["حليب", "بيض", "خبز", "موز", "سبانخ", "صدر دجاج", "أرز", "قهوة"],
		categories: [
			"منتجات الألبان",
			"مخبوزات",
			"فواكه وخضروات",
			"لحوم",
			"مواد غذائية",
		],
		packing: [
			"جواز سفر / بطاقة هوية",
			"شاحن الهاتف",
			"مستلزمات النظافة",
			"أدوية",
			"شواحن ومحولات",
			"ملابس داخلية وجوارب",
			"زجاجة ماء",
			"سماعات",
		],
		cleaning: [
			"نظّف الأرضيات بالمكنسة",
			"أخرج القمامة والمواد القابلة لإعادة التدوير",
			"نظّف الحمام",
			"غيّر أغطية السرير",
			"اغسل الملابس",
			"امسح أسطح المطبخ",
			"اسقِ النباتات",
			"اشترِ المواد الغذائية",
		],
	},
};

export type SetupPack = Readonly<{
	key: StarterKey;
	title: string;
	content: Readonly<{
		kind: "list";
		listKind: "shopping" | "checklist" | "tasks";
		icon: string;
		tasks: readonly Readonly<TemplateTask>[];
	}>;
}>;
export type SetupPackCatalog = Readonly<{
	catalogVersion: 1;
	locale: Locale;
	packs: readonly SetupPack[];
	dashboard: Readonly<{
		title: string;
		openTasksTitle: string;
		overdueTitle: string;
	}>;
}>;
const titleSchema = z.string().min(1).max(120);
const taskSchema = z
	.object({
		title: titleSchema,
		category: z.string().min(1).max(60).optional(),
		priority: z.number().int().min(1).max(3).optional(),
	})
	.strict();

export function createSetupPackCatalog(
	locale: Locale,
	catalogVersion: number,
): SetupPackCatalog {
	const capturedLocale = z.enum(LOCALES).parse(locale);
	z.literal(ACCOUNT_SETUP_CATALOG_VERSION).parse(catalogVersion);
	const local = labels[capturedLocale];
	const definitions = [
		{
			key: "shopping" as const,
			listKind: "shopping" as const,
			icon: "shopping-cart",
			tasks: local.shopping.map((title, index) => ({
				title,
				category: local.categories[[0, 0, 1, 2, 2, 3, 4, 4][index]],
			})),
		},
		{
			key: "packing" as const,
			listKind: "checklist" as const,
			icon: "plane",
			tasks: local.packing.map((title) => ({ title })),
		},
		{
			key: "cleaning" as const,
			listKind: "tasks" as const,
			icon: "spray-can",
			tasks: local.cleaning.map((title, index) => ({
				title,
				...(index === 2 ? { priority: 2 } : index === 7 ? { priority: 1 } : {}),
			})),
		},
	];
	const packs = definitions.map((definition, index) => {
		const tasks = z.array(taskSchema).length(8).parse(definition.tasks);
		const parsed = templateContentSchema.parse({
			kind: "list",
			listKind: definition.listKind,
			icon: definition.icon,
			tasks,
		});
		if (parsed.kind !== "list") throw new Error("Invalid setup pack");
		const content = Object.freeze({
			kind: "list" as const,
			listKind: definition.listKind,
			icon: definition.icon,
			tasks: Object.freeze(parsed.tasks.map((task) => Object.freeze(task))),
		});
		return Object.freeze({
			key: definition.key,
			title: titleSchema.parse(local.packTitles[index]),
			content,
		});
	});
	return Object.freeze({
		catalogVersion: ACCOUNT_SETUP_CATALOG_VERSION,
		locale: capturedLocale,
		packs: Object.freeze(packs),
		dashboard: Object.freeze({
			title: titleSchema.parse(local.dashboardTitles[0]),
			openTasksTitle: titleSchema.parse(local.dashboardTitles[1]),
			overdueTitle: titleSchema.parse(local.dashboardTitles[2]),
		}),
	});
}
