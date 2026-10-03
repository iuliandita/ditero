import { describe, expect, test } from "vitest";
import {
	appearanceSchema,
	DEFAULT_APPEARANCE,
	MAX_CUSTOM_THEMES,
	migrateLegacyAppearance,
	validateAppearance,
} from "./appearance.ts";
import { BUILTIN_THEME_DOCUMENTS } from "./theme-document.ts";

const custom = () => ({
	...DEFAULT_APPEARANCE,
	selected: "mine",
	documents: [
		{ id: "mine", document: structuredClone(BUILTIN_THEME_DOCUMENTS.paper) },
	],
});
describe("synced appearance validation", () => {
	test("explicit migration keeps legacy documents and lets the new edit replace the same identity", () => {
		const legacy = custom();
		const document = { ...BUILTIN_THEME_DOCUMENTS.slate, name: "Updated" };
		const migrated = migrateLegacyAppearance(legacy, {
			...DEFAULT_APPEARANCE,
			selected: "mine",
			accentTheme: "blue",
			documents: [{ id: "mine", document }],
		});
		expect(migrated.documents).toEqual([{ id: "mine", document }]);
		expect(migrated.accentTheme).toBe("blue");
		expect(
			migrateLegacyAppearance(legacy, DEFAULT_APPEARANCE).documents,
		).toEqual(legacy.documents);
	});
	test("accepts a paired custom palette and preserves the accent policy", () => {
		const input = { ...custom(), useAccent: false, accentTheme: "blue" };
		expect(validateAppearance(input)).toEqual(input);
	});
	test.each([
		"__proto__",
		"constructor",
		"prototype",
	])("rejects reserved identity %s", (id) => {
		const input = custom();
		input.documents[0].id = id;
		input.selected = id;
		expect(appearanceSchema.safeParse(input).success).toBe(false);
	});
	test("rejects missing selections, duplicate identities and oversized libraries", () => {
		const input = custom();
		expect(() =>
			validateAppearance({ ...input, selected: "missing" }),
		).toThrow();
		expect(() =>
			validateAppearance({
				...input,
				documents: [...input.documents, ...input.documents],
			}),
		).toThrow();
		expect(() =>
			validateAppearance({
				...input,
				documents: Array.from(
					{ length: MAX_CUSTOM_THEMES + 1 },
					(_, index) => ({ ...input.documents[0], id: `theme-${index}` }),
				),
			}),
		).toThrow();
	});
	test("rejects unknown, inherited and prototype-shaped fields before persistence", () => {
		const input = custom();
		expect(() =>
			validateAppearance({ ...input, css: "url(https://example.test)" }),
		).toThrow();
		expect(() =>
			validateAppearance(Object.assign(Object.create({ leaked: true }), input)),
		).toThrow();
		expect(() =>
			validateAppearance(
				JSON.parse(`${JSON.stringify(input).slice(0, -1)},"__proto__":{}}`),
			),
		).toThrow();
		expect(() =>
			validateAppearance({
				...input,
				documents: [{ ...input.documents[0], extra: true }],
			}),
		).toThrow();
	});
	test("bounds raw serialized bytes before parsing color documents", () => {
		const input = custom();
		input.documents[0].document.name = "x".repeat(350_001);
		expect(() => validateAppearance(input)).toThrow("too large");
	});
	test("rejects unsafe CSS, unreadable contrast and unknown accents", () => {
		const input = custom();
		input.documents[0].document.light.foreground = "#faf7f0";
		expect(() => validateAppearance(input)).toThrow("contrast");
		input.documents[0].document.light.foreground = "url(https://example.test)";
		expect(appearanceSchema.safeParse(input).success).toBe(false);
		expect(() =>
			validateAppearance({ ...DEFAULT_APPEARANCE, accentTheme: "unknown" }),
		).toThrow();
	});
});
