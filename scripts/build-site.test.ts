import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildSite,
	fields,
	locales,
	parseDictionary,
	renderPage,
} from "./build-site.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const english = parseDictionary(
	JSON.parse(await readFile(join(root, "site/locales/en.json"), "utf8")),
);

describe("static project site", () => {
	it.each(
		locales,
	)("requires a complete, exact %s dictionary", async (locale) => {
		const dictionary = parseDictionary(
			JSON.parse(
				await readFile(join(root, `site/locales/${locale}.json`), "utf8"),
			),
		);
		expect(Object.keys(dictionary).sort()).toEqual([...fields].sort());
		expect(() => parseDictionary({ ...dictionary, extra: "x" })).toThrow();
		const missing: Record<string, string> = { ...dictionary };
		delete missing.heading;
		expect(() => parseDictionary(missing)).toThrow();
	});
	it("refuses empty, non-string and invalid Unicode text", () => {
		for (const heading of [" ", 42, "\ud800", "bad\u0000text"])
			expect(() => parseDictionary({ ...english, heading })).toThrow();
	});
	it("escapes text in element and attribute contexts without interpreting new placeholders", () => {
		const payload = '<script>alert("x")</script> & \' @@sourceUrl@@';
		const html = renderPage(
			'<title>@@title@@</title><meta content="@@description@@">',
			"en",
			{ ...english, title: payload, description: payload },
		);
		expect(html).toContain(
			"&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39; @@sourceUrl@@",
		);
		expect(html).not.toContain("<script>");
		expect(() => renderPage("@@unknown@@", "en", english)).toThrow();
	});
	it.each(
		locales,
	)("renders the %s product preview and native disclosures", async (locale) => {
		const dictionary = parseDictionary(
			JSON.parse(
				await readFile(join(root, `site/locales/${locale}.json`), "utf8"),
			),
		);
		const html = renderPage(
			await readFile(join(root, "site/template.html"), "utf8"),
			locale,
			dictionary,
		);
		const prefix = locale === "en" ? "./" : "../";
		expect(html).toContain(`<img src="${prefix}assets/app-preview-light.png"`);
		expect(html).toContain(`srcset="${prefix}assets/app-preview-dark.png"`);
		expect(html).toContain(`alt="${dictionary.previewAlt}"`);
		expect(html).toContain(
			`<figcaption>${dictionary.previewCaption}</figcaption>`,
		);
		expect(html.match(/<details/g)).toHaveLength(2);
		expect(html.match(/<summary>/g)).toHaveLength(2);
		expect(html.match(/class="button primary"/g)).toHaveLength(1);
		expect(html).toContain('class="text-action"');
		expect(html.indexOf('class="product-preview"')).toBeGreaterThan(
			html.indexOf('class="actions"'),
		);
		expect(html.match(/hreflang=/g)).toHaveLength(12);
		expect(html).not.toContain("@@");
	});
	it("builds six real pages with valid relative navigation/assets and RTL", async () => {
		const output = await mkdtemp(join(tmpdir(), "ditero-site-test-"));
		try {
			await buildSite(root, output);
			for (const locale of locales) {
				const page = join(
					output,
					locale === "en" ? "index.html" : `${locale}/index.html`,
				);
				const html = await readFile(page, "utf8");
				expect(html).toContain(
					`<html lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}">`,
				);
				expect(html).not.toMatch(
					/<script|https:\/\/(fonts|www.google-analytics)/i,
				);
				expect(html.match(/aria-current="page"/g)).toHaveLength(1);
				expect(html.match(/hreflang=/g)).toHaveLength(12);
				for (const asset of ["app-preview-light.png", "app-preview-dark.png"]) {
					expect(await readFile(join(output, "assets", asset))).toEqual(
						await readFile(join(root, "site/assets", asset)),
					);
				}
				expect(html).toContain("<bdi>v0.0.1-alpha.2</bdi>");
				expect(html).not.toContain("v0.0.1-alpha.1");
				expect(html).not.toContain("@@releaseVersion@@");
				expect(
					html.match(
						/href="https:\/\/github.com\/iuliandita\/ditero\/releases\/tag\/v0\.0\.1-alpha\.2"/g,
					),
				).toHaveLength(2);
				const dictionary = parseDictionary(
					JSON.parse(
						await readFile(join(root, `site/locales/${locale}.json`), "utf8"),
					),
				);
				expect(dictionary.alpha).toContain("v0.0.1-alpha.2");
				for (const target of [
					"README.md#run-it-docker-compose",
					"apps/android/README.md",
					"apps/desktop/README.md",
					"docs/runbooks/backup-restore.md",
					"docs/security.md",
					"LICENSE",
				]) {
					expect(html).toContain(
						`href="https://github.com/iuliandita/ditero/blob/v0.0.1-alpha.2/${target}"`,
					);
				}
				const githubLinks = [
					...html.matchAll(
						/href="(https:\/\/github.com\/iuliandita\/ditero[^"]*)"/g,
					),
				].map((match) => match[1]);
				expect(githubLinks).toHaveLength(10);
				expect(
					githubLinks.every(
						(url) =>
							url === "https://github.com/iuliandita/ditero" ||
							url?.includes("/v0.0.1-alpha.2"),
					),
				).toBe(true);
				for (const match of html.matchAll(/(?:href|src|srcset)="([^"#]+)"/g)) {
					const target = match[1];
					if (!target || target.startsWith("https://")) continue;
					const file = resolve(dirname(page), target);
					expect(file === output || file.startsWith(`${output}/`)).toBe(true);
					const metadata = await stat(file);
					if (metadata.isDirectory()) await stat(join(file, "index.html"));
				}
			}
			expect(
				(await stat(join(output, "assets/ditero-symbol-teal.png"))).size,
			).toBeGreaterThan(0);
		} finally {
			await rm(output, { recursive: true, force: true });
		}
	});
});
