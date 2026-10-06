import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildSite,
	copy,
	fields,
	locales,
	parseDictionary,
	renderPage,
} from "./build-site.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const template = await readFile(join(root, "site/template.html"), "utf8");
const targets = {
	en: "https://ditero.app/",
	de: "https://ditero.app/de/",
	es: "https://ditero.app/es/",
	fr: "https://ditero.app/fr/",
	ro: "https://ditero.app/ro/",
	ar: "https://ditero.app/ar/",
};

describe("website forwarding pages", () => {
	it.each(locales)("requires complete, exact %s forwarding text", (locale) => {
		const dictionary = parseDictionary(copy[locale]);
		expect(Object.keys(dictionary).sort()).toEqual([...fields].sort());
		expect(() => parseDictionary({ ...dictionary, extra: "x" })).toThrow();
		const missing: Record<string, string> = { ...dictionary };
		delete missing.message;
		expect(() => parseDictionary(missing)).toThrow();
	});
	it("refuses empty, non-string and invalid Unicode text", () => {
		for (const message of [" ", 42, "\ud800", "bad\u0000text"])
			expect(() => parseDictionary({ ...copy.en, message })).toThrow();
	});
	it("escapes text in element and attribute contexts without interpreting new placeholders", () => {
		const payload = '<script>alert("x")</script> & \' @@canonical@@';
		const html = renderPage(
			'<title>@@title@@</title><meta content="@@message@@"><a>@@link@@</a>',
			"en",
			{ title: payload, message: payload, link: payload },
		);
		expect(html).toContain(
			"&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39; @@canonical@@",
		);
		expect(html).not.toContain("<script>");
		expect(html.match(/@@canonical@@/g)).toHaveLength(3);
		expect(() => renderPage("@@unknown@@", "en")).toThrow();
	});
	it.each(
		locales,
	)("forwards %s to its canonical locale with a visible fallback", (locale) => {
		const html = renderPage(template, locale);
		expect(html).toContain(`<link rel="canonical" href="${targets[locale]}">`);
		expect(html).toContain(
			`<meta http-equiv="refresh" content="0;url=${targets[locale]}">`,
		);
		expect(html).toContain(
			`<a href="${targets[locale]}">${copy[locale].link}</a>`,
		);
		expect(html).toContain(`<p>${copy[locale].message}</p>`);
		expect(html).toContain(
			`<html lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}">`,
		);
		expect(html.match(/hreflang=/g)).toHaveLength(6);
		for (const other of locales)
			expect(html).toContain(`hreflang="${other}" href="${targets[other]}"`);
		expect(html).not.toContain("@@");
		expect(html).not.toMatch(
			/<script|<img|<picture|stylesheet|tracker|alpha|releases\/|app-preview/i,
		);
	});
	it("builds exactly six confined pages without old marketing assets or dictionaries", async () => {
		const output = await mkdtemp(join(tmpdir(), "ditero-site-test-"));
		const input = await mkdtemp(join(tmpdir(), "ditero-site-input-"));
		try {
			const { mkdir, writeFile } = await import("node:fs/promises");
			await mkdir(join(input, "site"));
			await writeFile(join(input, "site/template.html"), template);
			await buildSite(input, output);
			expect((await readdir(output)).sort()).toEqual(
				[
					".nojekyll",
					"index.html",
					...locales.filter((locale) => locale !== "en"),
				].sort(),
			);
			for (const locale of locales) {
				const page = resolve(
					output,
					locale === "en" ? "index.html" : `${locale}/index.html`,
				);
				expect(page.startsWith(`${resolve(output)}/`)).toBe(true);
				expect((await stat(page)).isFile()).toBe(true);
				if (locale !== "en")
					expect(await readdir(dirname(page))).toEqual(["index.html"]);
				const html = await readFile(page, "utf8");
				expect(html).toBe(renderPage(template, locale));
				const links = [...html.matchAll(/href="([^"]+)"/g)].map(
					(match) => match[1],
				);
				expect(links).toHaveLength(8);
				for (const link of links) {
					const url = new URL(link ?? "");
					expect(url.origin).toBe("https://ditero.app");
					expect(Object.values(targets)).toContain(url.href);
				}
			}
			expect(await readFile(join(output, ".nojekyll"), "utf8")).toBe("");
		} finally {
			await rm(output, { recursive: true, force: true });
			await rm(input, { recursive: true, force: true });
		}
	});
});
