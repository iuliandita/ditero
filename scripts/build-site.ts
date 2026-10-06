import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const locales = ["en", "de", "es", "fr", "ro", "ar"] as const;
export type Locale = (typeof locales)[number];
export const fields = ["title", "message", "link"] as const;
export type Dictionary = Record<(typeof fields)[number], string>;
export const siteUrl = "https://ditero.app/";
export const copy: Record<Locale, Dictionary> = {
	en: {
		title: "Ditero website",
		message: "The Ditero website is now at ditero.app.",
		link: "Continue to the Ditero website",
	},
	de: {
		title: "Ditero-Website",
		message: "Die Ditero-Website ist jetzt auf ditero.app.",
		link: "Zur Ditero-Website",
	},
	es: {
		title: "Sitio web de Ditero",
		message: "El sitio web de Ditero ahora está en ditero.app.",
		link: "Ir al sitio web de Ditero",
	},
	fr: {
		title: "Site de Ditero",
		message: "Le site de Ditero se trouve maintenant sur ditero.app.",
		link: "Continuer vers le site de Ditero",
	},
	ro: {
		title: "Site-ul Ditero",
		message: "Site-ul Ditero este acum la ditero.app.",
		link: "Continuă pe site-ul Ditero",
	},
	ar: {
		title: "موقع Ditero",
		message: "موقع Ditero الآن على ditero.app.",
		link: "انتقل إلى موقع Ditero",
	},
};

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
	dictionary: Dictionary = copy[locale],
): string {
	if (!locales.includes(locale)) throw new Error("Unsupported site locale");
	const path = (target: Locale) => (target === "en" ? "" : `${target}/`);
	const values: Record<string, string> = {
		...Object.fromEntries(
			Object.entries(parseDictionary(dictionary)).map(([key, value]) => [
				key,
				escapeHtml(value),
			]),
		),
		canonical: escapeHtml(`${siteUrl}${path(locale)}`),
		alternates: locales
			.map(
				(target) =>
					`<link rel="alternate" hreflang="${target}" href="${siteUrl}${path(target)}">`,
			)
			.join("\n"),
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
	const pages = locales.map((locale) => ({
		locale,
		html: renderPage(template, locale),
	}));
	for (const page of pages) {
		const file = join(
			output,
			page.locale === "en" ? "index.html" : `${page.locale}/index.html`,
		);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, page.html);
	}
	await writeFile(join(output, ".nojekyll"), "");
}

if (import.meta.main) {
	const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
	await buildSite(root, join(root, "site/dist"));
	console.log(`Built ${locales.length} website forwarding pages.`);
}
