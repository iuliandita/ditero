import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export type Variant = {
	declarations: string[];
	selectors: string[];
	match: Record<string, string>;
};

export type MessageValue = string | Variant[];
export type Catalog = Record<string, MessageValue>;

export type IssueType =
	| "missing-key"
	| "extra-key"
	| "empty-value"
	| "placeholder-missing"
	| "placeholder-extra"
	| "protected-term-missing"
	| "protected-term-casing"
	| "plural-category"
	| "shape";

export type Issue = {
	type: IssueType;
	locale: string;
	key: string;
	detail: string;
};

export type ValidationResult = {
	ok: boolean;
	issues: Issue[];
	byType: Record<IssueType, Issue[]>;
};

const ISSUE_TYPES: IssueType[] = [
	"missing-key",
	"extra-key",
	"shape",
	"empty-value",
	"placeholder-missing",
	"placeholder-extra",
	"protected-term-missing",
	"protected-term-casing",
	"plural-category",
];

// Brand and product names that must survive translation byte-for-byte. The
// check is case-sensitive on purpose: "ntfy" is lowercase, "Karma" is
// capitalized, and either one recased is a different name.
export const PROTECTED_TERMS = [
	"Ditero",
	"ntfy",
	"Telegram",
	"Discord",
	"Slack",
	"Pomodoro",
	"Karma",
] as const;

const PLACEHOLDER = /\{\s*\$?([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;
const PLURAL_DECLARATION = /^local\s+([A-Za-z_]\w*)\s*=\s*.+:\s*plural\s*$/;
const MATCH_PART = /^([A-Za-z_]\w*)=(\*|[A-Za-z0-9_]+)$/;

function isMessageKey(key: string): boolean {
	return !key.startsWith("$");
}

function isComplex(value: MessageValue): value is Variant[] {
	return Array.isArray(value);
}

function messageTexts(value: MessageValue): string[] {
	if (!isComplex(value)) return [value];
	return value.flatMap((variant) => Object.values(variant.match ?? {}));
}

function placeholdersOf(value: MessageValue): Set<string> {
	const found = new Set<string>();
	for (const text of messageTexts(value)) {
		for (const hit of text.matchAll(PLACEHOLDER)) {
			if (hit[1]) found.add(hit[1]);
		}
	}
	return found;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Human-readable problem, or null when the variant array is well-formed. */
function variantProblem(variants: Variant[]): string | null {
	if (variants.length === 0) return "variant array is empty";
	for (const variant of variants) {
		if (typeof variant !== "object" || variant === null) {
			return "variant is not an object";
		}
		if (!isStringArray(variant.declarations)) {
			return "declarations must be an array of strings";
		}
		if (!isStringArray(variant.selectors) || variant.selectors.length === 0) {
			return "selectors must be a non-empty array of strings";
		}
		const entries = Object.entries(variant.match ?? {});
		if (entries.length === 0) return "match has no variants";
		for (const [key, text] of entries) {
			if (typeof text !== "string") return `match "${key}" is not a string`;
			if (key === "*") continue;
			const parts = key.split(/\s+/);
			if (parts.length !== variant.selectors.length) {
				return `match "${key}" does not cover every selector`;
			}
			for (const part of parts) {
				const parsed = part.match(MATCH_PART);
				if (!parsed) return `match "${key}" is not "selector=category"`;
				if (!parsed[1] || !variant.selectors.includes(parsed[1])) {
					return `match "${key}" names an undeclared selector`;
				}
			}
		}
	}
	return null;
}

function pluralSelectors(variant: Variant): string[] {
	const declared = variant.declarations.flatMap((declaration) => {
		const parsed = declaration.trim().match(PLURAL_DECLARATION);
		return parsed?.[1] ? [parsed[1]] : [];
	});
	return variant.selectors.filter((selector) => declared.includes(selector));
}

function categoriesFor(variant: Variant, selector: string): Set<string> {
	const present = new Set<string>();
	for (const key of Object.keys(variant.match)) {
		if (key === "*") continue;
		for (const part of key.split(/\s+/)) {
			const parsed = part.match(MATCH_PART);
			if (parsed?.[1] === selector && parsed[2]) present.add(parsed[2]);
		}
	}
	return present;
}

// Derived from the locale's own CLDR data instead of a hardcoded table, so a
// new locale (or a CLDR revision, e.g. es/fr gaining "many") needs no edit here.
function requiredCategories(locale: string): string[] {
	return [...new Intl.PluralRules(locale).resolvedOptions().pluralCategories];
}

function termPattern(term: string): RegExp {
	return new RegExp(`(?<![A-Za-z])${term}(?![A-Za-z])`, "gi");
}

export function validateCatalogs(
	catalogs: Record<string, Catalog>,
	options: { baseLocale?: string } = {},
): ValidationResult {
	const baseLocale = options.baseLocale ?? "en";
	const base = catalogs[baseLocale];
	if (!base) {
		throw new Error(
			`base locale "${baseLocale}" is absent from the catalogs under validation`,
		);
	}

	const issues: Issue[] = [];
	const add = (
		type: IssueType,
		locale: string,
		key: string,
		detail: string,
	) => {
		issues.push({ type, locale, key, detail });
	};

	const baseKeys = Object.keys(base).filter(isMessageKey);

	for (const [locale, catalog] of Object.entries(catalogs)) {
		const keys = new Set(Object.keys(catalog).filter(isMessageKey));

		if (locale !== baseLocale) {
			for (const key of keys) {
				if (!baseKeys.includes(key)) {
					add("extra-key", locale, key, "not present in the base catalog");
				}
			}
		}

		for (const key of baseKeys) {
			const baseValue = base[key] as MessageValue;
			if (!keys.has(key)) {
				if (locale !== baseLocale) {
					add("missing-key", locale, key, "absent from this catalog");
				}
				continue;
			}
			const value = catalog[key] as MessageValue;

			if (isComplex(baseValue) !== isComplex(value)) {
				add(
					"shape",
					locale,
					key,
					isComplex(baseValue)
						? "base is a plural message, this catalog has a plain string"
						: "base is a plain string, this catalog has a plural message",
				);
				continue;
			}

			if (isComplex(value)) {
				const problem = variantProblem(value);
				if (problem) {
					add("shape", locale, key, problem);
					continue;
				}
			}

			const texts = messageTexts(value);
			if (texts.some((text) => text.trim() === "")) {
				add("empty-value", locale, key, "value is blank or whitespace-only");
			}

			if (locale !== baseLocale) {
				const expected = placeholdersOf(baseValue);
				const actual = placeholdersOf(value);
				const dropped = [...expected].filter((p) => !actual.has(p)).sort();
				const invented = [...actual].filter((p) => !expected.has(p)).sort();
				if (dropped.length > 0) {
					add(
						"placeholder-missing",
						locale,
						key,
						`missing ${dropped.map((p) => `{${p}}`).join(", ")}`,
					);
				}
				if (invented.length > 0) {
					add(
						"placeholder-extra",
						locale,
						key,
						`not in the base message: ${invented
							.map((p) => `{${p}}`)
							.join(", ")}`,
					);
				}
			}

			const text = texts.join("\n");
			if (locale !== baseLocale) {
				const baseText = messageTexts(baseValue).join("\n");
				const lost = PROTECTED_TERMS.filter(
					(term) => termPattern(term).test(baseText) && !text.includes(term),
				);
				if (lost.length > 0) {
					add(
						"protected-term-missing",
						locale,
						key,
						`must keep verbatim: ${lost.join(", ")}`,
					);
				}
			}

			const miscased = new Set<string>();
			for (const term of PROTECTED_TERMS) {
				for (const hit of text.matchAll(termPattern(term))) {
					if (hit[0] !== term) {
						miscased.add(`"${hit[0]}" should be "${term}"`);
					}
				}
			}
			if (miscased.size > 0) {
				add("protected-term-casing", locale, key, [...miscased].join(", "));
			}

			if (isComplex(value)) {
				const required = requiredCategories(locale);
				for (const variant of value) {
					for (const selector of pluralSelectors(variant)) {
						const present = categoriesFor(variant, selector);
						const missing = required.filter((c) => !present.has(c));
						if (missing.length > 0) {
							add(
								"plural-category",
								locale,
								key,
								`selector "${selector}" is missing CLDR ${
									missing.length === 1 ? "category" : "categories"
								} ${missing.join(", ")}`,
							);
						}
					}
				}
			}
		}
	}

	const byType = Object.fromEntries(
		ISSUE_TYPES.map((type) => [type, issues.filter((i) => i.type === type)]),
	) as Record<IssueType, Issue[]>;

	return { ok: issues.length === 0, issues, byType };
}

function main(): never {
	const root = resolve(import.meta.dirname, "..");
	const messagesDir = join(root, "messages");
	const settings = JSON.parse(
		readFileSync(join(root, "project.inlang", "settings.json"), "utf8"),
	) as { baseLocale?: string };
	if (!settings.baseLocale) {
		throw new Error("project.inlang/settings.json declares no baseLocale");
	}

	const catalogs: Record<string, Catalog> = {};
	for (const file of readdirSync(messagesDir).sort()) {
		if (!file.endsWith(".json")) continue;
		catalogs[basename(file, ".json")] = JSON.parse(
			readFileSync(join(messagesDir, file), "utf8"),
		) as Catalog;
	}

	const result = validateCatalogs(catalogs, {
		baseLocale: settings.baseLocale,
	});
	const locales = Object.keys(catalogs).join(", ");
	if (result.ok) {
		console.log(`i18n: ${locales} - no catalog issues`);
		process.exit(0);
	}

	for (const type of ISSUE_TYPES) {
		const group = result.byType[type];
		if (group.length === 0) continue;
		console.error(`\n${type} (${group.length})`);
		for (const issue of group) {
			console.error(`  ${issue.locale}  ${issue.key}: ${issue.detail}`);
		}
	}
	console.error(
		`\ni18n: ${result.issues.length} catalog issue(s) in ${locales}`,
	);
	process.exit(1);
}

if (import.meta.main) {
	main();
}
