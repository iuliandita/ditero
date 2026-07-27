import { describe, expect, test } from "vitest";
import {
	type Catalog,
	type IssueType,
	PROTECTED_TERMS,
	validateCatalogs,
} from "./i18n-validate.ts";

function plural(match: Record<string, string>): Catalog[string] {
	return [
		{
			declarations: ["input count", "local countPlural = count: plural"],
			selectors: ["countPlural"],
			match,
		},
	];
}

function en(): Catalog {
	return {
		$schema: "https://inlang.com/schema/inlang-message-format",
		app_name: "Ditero",
		greeting: "Hello {name}, welcome to {place}",
		quickadd_placeholder: "e.g. Buy milk {date} {priority} {label} {list}",
		notify_channel_ntfy: "Send to ntfy, Telegram, Discord, Slack",
		focus_title: "Pomodoro timer",
		karma_title: "Karma",
		board_column_count: plural({
			"countPlural=one": "{count} item",
			"countPlural=other": "{count} items",
		}),
	};
}

function translated(overrides: Catalog = {}): Catalog {
	return {
		$schema: "https://inlang.com/schema/inlang-message-format",
		app_name: "Ditero",
		greeting: "Hallo {name}, willkommen in {place}",
		quickadd_placeholder: "z. B. Milch kaufen {date} {priority} {label} {list}",
		notify_channel_ntfy: "Senden an ntfy, Telegram, Discord, Slack",
		focus_title: "Pomodoro-Timer",
		karma_title: "Karma",
		board_column_count: plural({
			"countPlural=one": "{count} Element",
			"countPlural=other": "{count} Elemente",
		}),
		...overrides,
	};
}

function typesOf(catalogs: Record<string, Catalog>): IssueType[] {
	return [...new Set(validateCatalogs(catalogs).issues.map((i) => i.type))];
}

function issuesOf(catalogs: Record<string, Catalog>, type: IssueType) {
	return validateCatalogs(catalogs).issues.filter((i) => i.type === type);
}

describe("validateCatalogs", () => {
	test("a fully valid catalog set reports zero issues", () => {
		const result = validateCatalogs({ en: en(), de: translated() });
		expect(result.issues).toEqual([]);
		expect(result.ok).toBe(true);
	});

	test("en alone is valid", () => {
		expect(validateCatalogs({ en: en() }).ok).toBe(true);
	});

	test("throws when the base locale is absent", () => {
		expect(() => validateCatalogs({ de: translated() })).toThrow(
			/base locale/i,
		);
	});

	test("$schema is not treated as a message key", () => {
		const missingSchema = translated();
		delete missingSchema.$schema;
		expect(validateCatalogs({ en: en(), de: missingSchema }).ok).toBe(true);

		const baseWithoutSchema = en();
		delete baseWithoutSchema.$schema;
		const result = validateCatalogs({
			en: baseWithoutSchema,
			de: translated(),
		});
		expect(result.issues).toEqual([]);
	});

	test("missing key", () => {
		const de = translated();
		delete de.focus_title;
		const found = issuesOf({ en: en(), de }, "missing-key");
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ locale: "de", key: "focus_title" });
	});

	test("extra key", () => {
		const de = translated({ stale_renamed_key: "Veraltet" });
		const found = issuesOf({ en: en(), de }, "extra-key");
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ locale: "de", key: "stale_renamed_key" });
	});

	test("empty value", () => {
		const de = translated({ focus_title: "   " });
		const found = issuesOf({ en: en(), de }, "empty-value");
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ locale: "de", key: "focus_title" });
	});

	test("empty value inside a plural variant", () => {
		const de = translated({
			board_column_count: plural({
				"countPlural=one": "{count} Element",
				"countPlural=other": "",
			}),
		});
		expect(issuesOf({ en: en(), de }, "empty-value")).toHaveLength(1);
	});

	test("placeholder dropped by the translation", () => {
		const de = translated({ greeting: "Hallo {name}" });
		const found = issuesOf({ en: en(), de }, "placeholder-missing");
		expect(found).toHaveLength(1);
		expect(found[0]?.detail).toContain("place");
	});

	test("placeholder invented by the translation", () => {
		const de = translated({
			greeting: "Hallo {name}, willkommen in {place} um {time}",
		});
		const found = issuesOf({ en: en(), de }, "placeholder-extra");
		expect(found).toHaveLength(1);
		expect(found[0]?.detail).toContain("time");
	});

	test("reordered placeholders are accepted", () => {
		const de = translated({ greeting: "In {place}: hallo {name}" });
		expect(validateCatalogs({ en: en(), de }).ok).toBe(true);
	});

	test("quickadd_placeholder losing a parser param is caught by placeholder parity", () => {
		const de = translated({
			quickadd_placeholder: "z. B. Milch kaufen {date} {priority} {label}",
		});
		const found = issuesOf({ en: en(), de }, "placeholder-missing");
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ key: "quickadd_placeholder" });
		expect(found[0]?.detail).toContain("list");
	});

	test("protected term translated away", () => {
		const de = translated({ focus_title: "Tomaten-Timer" });
		const found = issuesOf({ en: en(), de }, "protected-term-missing");
		expect(found).toHaveLength(1);
		expect(found[0]?.detail).toContain("Pomodoro");
	});

	test("protected term inside a plural variant is enforced", () => {
		const withTerm = plural({
			"countPlural=one": "{count} Karma point",
			"countPlural=other": "{count} Karma points",
		});
		const base = { ...en(), karma_points: withTerm };
		const de = translated({
			karma_points: plural({
				"countPlural=one": "{count} Punkt",
				"countPlural=other": "{count} Punkte",
			}),
		});
		expect(issuesOf({ en: base, de }, "protected-term-missing")).toHaveLength(
			1,
		);
	});

	test("protected term is case-sensitive", () => {
		const de = translated({ karma_title: "karma" });
		const result = validateCatalogs({ en: en(), de });
		expect(result.byType["protected-term-missing"].map((i) => i.key)).toContain(
			"karma_title",
		);
		expect(result.byType["protected-term-casing"].map((i) => i.key)).toContain(
			"karma_title",
		);
	});

	test("a lowercase protected term in the base catalog itself fails", () => {
		const base = { ...en(), karma_hint: "Earn karma every day" };
		const de = translated({ karma_hint: "Verdiene Karma jeden Tag" });
		const found = issuesOf({ en: base, de }, "protected-term-casing");
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ locale: "en", key: "karma_hint" });
	});

	test("protected terms are not matched inside longer words", () => {
		const base = { ...en(), unrelated: "Slackers and Discordant timing" };
		const de = translated({ unrelated: "Faulenzer und misstoenendes Timing" });
		const result = validateCatalogs({ en: base, de });
		expect(result.byType["protected-term-casing"]).toEqual([]);
		expect(result.byType["protected-term-missing"]).toEqual([]);
	});

	test("PROTECTED_TERMS covers the brand set", () => {
		expect([...PROTECTED_TERMS].sort()).toEqual([
			"Discord",
			"Ditero",
			"Karma",
			"Pomodoro",
			"Slack",
			"Telegram",
			"ntfy",
		]);
	});

	test("ar plural missing CLDR categories", () => {
		const ar = translated({
			board_column_count: plural({
				"countPlural=one": "عنصر واحد",
				"countPlural=other": "{count} عنصر",
			}),
		});
		const found = issuesOf({ en: en(), ar }, "plural-category");
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ locale: "ar", key: "board_column_count" });
		for (const category of ["zero", "two", "few", "many"]) {
			expect(found[0]?.detail).toContain(category);
		}
	});

	test("required categories are derived from Intl, not a hardcoded table", () => {
		const locale = "ar";
		const required = new Intl.PluralRules(locale).resolvedOptions()
			.pluralCategories;
		const ar = translated({
			board_column_count: plural({ "countPlural=other": "{count} عنصر" }),
		});
		const found = issuesOf({ en: en(), [locale]: ar }, "plural-category");
		for (const category of required) {
			if (category === "other") continue;
			expect(found[0]?.detail).toContain(category);
		}
	});

	test("a complete ar plural passes", () => {
		const ar = translated({
			board_column_count: plural(
				Object.fromEntries(
					new Intl.PluralRules("ar")
						.resolvedOptions()
						.pluralCategories.map((c) => [`countPlural=${c}`, `{count} عنصر`]),
				),
			),
		});
		expect(issuesOf({ en: en(), ar }, "plural-category")).toEqual([]);
	});

	test("ro plural missing few", () => {
		const ro = translated({
			board_column_count: plural({
				"countPlural=one": "{count} element",
				"countPlural=other": "{count} elemente",
			}),
		});
		const found = issuesOf({ en: en(), ro }, "plural-category");
		expect(found).toHaveLength(1);
		expect(found[0]?.detail).toContain("few");
	});

	test("es requires the categories its own CLDR data declares", () => {
		const es = translated({
			board_column_count: plural({
				"countPlural=one": "{count} elemento",
				"countPlural=other": "{count} elementos",
			}),
		});
		const required = new Intl.PluralRules("es").resolvedOptions()
			.pluralCategories;
		const found = issuesOf({ en: en(), es }, "plural-category");
		expect(found).toHaveLength(required.includes("many") ? 1 : 0);
	});

	test("the base locale's own plural completeness is validated", () => {
		const base = {
			...en(),
			board_column_count: plural({ "countPlural=other": "{count} items" }),
		};
		const found = issuesOf({ en: base }, "plural-category");
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ locale: "en" });
		expect(found[0]?.detail).toContain("one");
	});

	test("a bare wildcard does not stand in for the categories a locale needs", () => {
		const ar = translated({
			board_column_count: plural({ "*": "{count} عنصر" }),
		});
		expect(issuesOf({ en: en(), ar }, "plural-category")).toHaveLength(1);
	});

	test("shape mismatch: plural in en, plain string in the translation", () => {
		const de = translated({ board_column_count: "{count} Elemente" });
		const found = issuesOf({ en: en(), de }, "shape");
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ locale: "de", key: "board_column_count" });
	});

	test("shape mismatch: plain string in en, plural in the translation", () => {
		const de = translated({
			focus_title: plural({ "countPlural=other": "Timer" }),
		});
		expect(issuesOf({ en: en(), de }, "shape")).toHaveLength(1);
	});

	test("a declaration-only number message needs no selector", () => {
		const withNumber = (points: string): Catalog[string] => [
			{
				declarations: ["input points", "local pointsNum = points: number"],
				selectors: [],
				match: { "*": points },
			},
		];
		const result = validateCatalogs({
			en: { ...en(), karma_points_short: withNumber("{pointsNum} pts") },
			de: {
				...translated(),
				karma_points_short: withNumber("{pointsNum} Pkt."),
			},
		});
		expect(result.issues).toEqual([]);
	});

	test("an empty selector list without a formatter is still a shape fault", () => {
		const de = translated({
			board_column_count: [
				{
					declarations: ["input count"],
					selectors: [],
					match: { "*": "{count} Elemente" },
				},
			],
		});
		const found = issuesOf({ en: en(), de }, "shape");
		expect(found).toHaveLength(1);
		expect(found[0]?.detail).toMatch(/no formatter is declared/);
	});

	test("a selector-less variant still rejects a categorised match key", () => {
		const de = translated({
			board_column_count: [
				{
					declarations: ["input count", "local countNum = count: number"],
					selectors: [],
					match: { "countPlural=one": "{countNum} Element" },
				},
			],
		});
		expect(issuesOf({ en: en(), de }, "shape")).toHaveLength(1);
	});

	test("malformed variant objects are reported, not thrown", () => {
		const de = translated({
			board_column_count: [
				{ declarations: [], selectors: [], match: {} },
			] as Catalog[string],
		});
		expect(issuesOf({ en: en(), de }, "shape")).toHaveLength(1);
	});

	test("issues are grouped by type and ok reflects emptiness", () => {
		const de = translated({ focus_title: "   " });
		delete de.karma_title;
		const result = validateCatalogs({ en: en(), de });
		expect(result.ok).toBe(false);
		expect(result.byType["empty-value"]).toHaveLength(1);
		expect(result.byType["missing-key"]).toHaveLength(1);
		expect(result.byType["extra-key"]).toEqual([]);
	});

	test("a locale with several independent faults reports all of them", () => {
		const de = translated({
			greeting: "Hallo {name}",
			focus_title: "Tomaten-Timer",
			stale_key: "Alt",
		});
		delete de.app_name;
		expect(typesOf({ en: en(), de }).sort()).toEqual([
			"extra-key",
			"missing-key",
			"placeholder-missing",
			"protected-term-missing",
		]);
	});
});
