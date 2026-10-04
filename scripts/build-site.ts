import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const locales = ["en", "de", "es", "fr", "ro", "ar"] as const;
export type Locale = (typeof locales)[number];
export const fields = [
	"title",
	"description",
	"skip",
	"languages",
	"eyebrow",
	"heading",
	"intro",
	"download",
	"setup",
	"source",
	"everydayTitle",
	"everyday",
	"localTitle",
	"local",
	"filesTitle",
	"files",
	"requirementsTitle",
	"requirements",
	"clientsTitle",
	"clients",
	"alphaTitle",
	"alpha",
	"docsTitle",
	"android",
	"desktop",
	"backup",
	"security",
	"license",
	"releaseLabel",
] as const;
export type Dictionary = Record<(typeof fields)[number], string>;
const names: Record<Locale, string> = {
	en: "English",
	de: "Deutsch",
	es: "Español",
	fr: "Français",
	ro: "Română",
	ar: "العربية",
};
export const siteUrl = "https://iuliandita.github.io/ditero/";
const sourceUrl = "https://github.com/iuliandita/ditero";
const docsUrl = `${sourceUrl}/blob/v0.0.1-alpha.1`;
const assets = [
	"ditero-symbol-teal.png",
	"ditero-wordmark-light.png",
	"ditero-wordmark-dark.png",
];

export function parseDictionary(input: unknown): Dictionary {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("Invalid site dictionary");
	const record = input as Record<string, unknown>;
	if (
		Object.keys(record).length !== fields.length ||
		Object.keys(record).some(
			(key) => !fields.includes(key as (typeof fields)[number]),
		)
	)
		throw new Error("Site dictionary keys must match exactly");
	for (const field of fields) {
		const value = record[field];
		if (
			typeof value !== "string" ||
			!value.trim() ||
			!value.isWellFormed() ||
			value.includes("\u0000")
		)
			throw new Error(`Invalid site field: ${field}`);
	}
	return record as Dictionary;
}

export function escapeHtml(text: string): string {
	return text.replace(
		/[&<>"']/g,
		(char) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				char
			] ?? char,
	);
}

export function renderPage(
	template: string,
	locale: Locale,
	dictionary: Dictionary,
): string {
	const prefix = locale === "en" ? "./" : "../";
	const path = (target: Locale) => (target === "en" ? "" : `${target}/`);
	const languageLinks = locales
		.map(
			(target) =>
				`<a href="${prefix}${path(target)}" lang="${target}" hreflang="${target}"${target === locale ? ' aria-current="page"' : ""}>${escapeHtml(names[target])}</a>`,
		)
		.join("\n");
	const alternates = locales
		.map(
			(target) =>
				`<link rel="alternate" hreflang="${target}" href="${siteUrl}${path(target)}">`,
		)
		.join("\n");
	const values: Record<string, string> = {
		...Object.fromEntries(
			Object.entries(parseDictionary(dictionary)).map(([key, value]) => [
				key,
				escapeHtml(value),
			]),
		),
		prefix,
		home: `${prefix}${path(locale)}`,
		canonical: `${siteUrl}${path(locale)}`,
		languageLinks,
		alternates,
		releaseUrl: `${sourceUrl}/releases/tag/v0.0.1-alpha.1`,
		setupUrl: `${docsUrl}/README.md#run-it-docker-compose`,
		sourceUrl,
		androidUrl: `${docsUrl}/apps/android/README.md`,
		desktopUrl: `${docsUrl}/apps/desktop/README.md`,
		backupUrl: `${docsUrl}/docs/runbooks/backup-restore.md`,
		securityUrl: `${docsUrl}/docs/security.md`,
		licenseUrl: `${docsUrl}/LICENSE`,
	};
	return template
		.replace(
			'<html lang="en" dir="ltr">',
			`<html lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}">`,
		)
		.replace(/@@([^@]+)@@/g, (_match, key: string) => {
			if (!Object.hasOwn(values, key))
				throw new Error(`Unknown site template field: ${key}`);
			return values[key] ?? "";
		});
}

export async function buildSite(root: string, output: string): Promise<void> {
	const template = await readFile(join(root, "site/template.html"), "utf8");
	const pages = await Promise.all(
		locales.map(async (locale) => ({
			locale,
			html: renderPage(
				template,
				locale,
				parseDictionary(
					JSON.parse(
						await readFile(join(root, `site/locales/${locale}.json`), "utf8"),
					),
				),
			),
		})),
	);
	await mkdir(join(output, "assets"), { recursive: true });
	for (const page of pages) {
		const file = join(
			output,
			page.locale === "en" ? "index.html" : `${page.locale}/index.html`,
		);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, page.html);
	}
	await copyFile(join(root, "site/site.css"), join(output, "site.css"));
	for (const asset of assets)
		await copyFile(
			join(root, "assets/brand", asset),
			join(output, "assets", asset),
		);
	await writeFile(join(output, ".nojekyll"), "");
}

if (import.meta.main) {
	const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
	await buildSite(root, join(root, "site/dist"));
	console.log(`Built ${locales.length} static site pages.`);
}
