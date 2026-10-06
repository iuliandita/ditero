import { describe, expect, test } from "vitest";
import { LOCALES, type Locale } from "./locale.ts";
import { createSetupPackCatalog } from "./setup-packs.ts";
import { templateContentSchema } from "./template.ts";

describe("setup catalog version 1", () => {
	test.each(
		LOCALES,
	)("%s contains three localized timeless eight-item packs", (locale) => {
		const catalog = createSetupPackCatalog(locale, 1);
		expect(catalog.catalogVersion).toBe(1);
		expect(catalog.locale).toBe(locale);
		expect(catalog.packs.map((pack) => pack.key)).toEqual([
			"shopping",
			"packing",
			"cleaning",
		]);
		expect(catalog.packs.map((pack) => pack.content.listKind)).toEqual([
			"shopping",
			"checklist",
			"tasks",
		]);
		for (const pack of catalog.packs) {
			expect(pack.title.trim().length).toBeGreaterThan(0);
			expect(pack.title.length).toBeLessThanOrEqual(120);
			expect(templateContentSchema.safeParse(pack.content).success).toBe(true);
			expect(pack.content.tasks).toHaveLength(8);
			expect(new Set(pack.content.tasks.map((task) => task.title)).size).toBe(
				8,
			);
			for (const task of pack.content.tasks) {
				expect(task.title.trim().length).toBeGreaterThan(0);
				expect(task.title.length).toBeLessThanOrEqual(120);
				expect(
					Object.keys(task).every((key) =>
						["title", "category", "priority"].includes(key),
					),
				).toBe(true);
			}
		}
		const shopping = catalog.packs[0].content.tasks;
		expect(
			shopping.every(
				(task) =>
					typeof task.category === "string" && task.category.trim().length > 0,
			),
		).toBe(true);
		expect(new Set(shopping.map((task) => task.category)).size).toBe(5);
		expect(
			catalog.packs[1].content.tasks.every(
				(task) => Object.keys(task).length === 1,
			),
		).toBe(true);
		expect(
			catalog.packs[2].content.tasks.map((task) => task.priority ?? 0),
		).toEqual([0, 0, 2, 0, 0, 0, 0, 1]);
		for (const title of Object.values(catalog.dashboard)) {
			expect(title.trim().length).toBeGreaterThan(0);
			expect(title.length).toBeLessThanOrEqual(120);
		}
	});
	test.each(
		LOCALES.filter((locale) => locale !== "en"),
	)("%s does not fall back to English content", (locale) => {
		const english = createSetupPackCatalog("en", 1);
		const translated = createSetupPackCatalog(locale, 1);
		expect(translated.packs.map((pack) => pack.title)).not.toEqual(
			english.packs.map((pack) => pack.title),
		);
		for (let index = 0; index < 3; index++)
			expect(
				translated.packs[index].content.tasks.map((task) => task.title),
			).not.toEqual(
				english.packs[index].content.tasks.map((task) => task.title),
			);
		expect(
			translated.packs[0].content.tasks.map((task) => task.category),
		).not.toEqual(english.packs[0].content.tasks.map((task) => task.category));
		expect(translated.dashboard).not.toEqual(english.dashboard);
	});
	test.each([
		0,
		2,
		-1,
		1.5,
		NaN,
	])("rejects unsupported version %s", (version) => {
		expect(() => createSetupPackCatalog("en", version)).toThrow();
	});
	test.each([
		"xx",
		"EN",
		"",
		"en-US",
		"__proto__",
	])("rejects unknown locale %j", (locale) => {
		expect(() => createSetupPackCatalog(locale as Locale, 1)).toThrow();
	});
	test("repeated factories return equal deeply frozen independent objects", () => {
		const first = createSetupPackCatalog("ro", 1);
		const second = createSetupPackCatalog("ro", 1);
		expect(second).toEqual(first);
		expect(second).not.toBe(first);
		expect(second.packs[0].content.tasks[0]).not.toBe(
			first.packs[0].content.tasks[0],
		);
		for (const value of [
			first,
			first.dashboard,
			first.packs,
			...first.packs,
			...first.packs.map((pack) => pack.content),
			...first.packs.map((pack) => pack.content.tasks),
			...first.packs.flatMap((pack) => pack.content.tasks),
		])
			expect(Object.isFrozen(value)).toBe(true);
		expect(() =>
			Object.assign(first.packs[0].content.tasks[0], { title: "mutated" }),
		).toThrow();
		expect(createSetupPackCatalog("ro", 1)).toEqual(second);
	});
	test("locale is captured explicitly rather than process or browser defaults", () => {
		const arabic = createSetupPackCatalog("ar", 1);
		createSetupPackCatalog("de", 1);
		expect(createSetupPackCatalog("ar", 1)).toEqual(arabic);
		expect(arabic.dashboard.title).toBe("يومي");
	});
});
