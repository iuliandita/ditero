import { describe, expect, test } from "vitest";
import { m } from "../../paraglide/messages.js";
import { ICON_NAMES, iconLabel } from "./list-icon.tsx";

// Expected values are catalog literals, not `m.*()`: routing both sides through
// the same message passes even against an emptied entry.

describe("iconLabel", () => {
	// The registry and its names live in one file precisely so they cannot drift.
	// A new icon added to ICONS without a catalog name would otherwise announce
	// its raw lucide id again, which is the whole defect.
	test("every registry icon has a name that is not its identifier", () => {
		const unnamed = ICON_NAMES.filter((name) => iconLabel(name) === name);
		expect(unnamed).toEqual([]);
		expect(ICON_NAMES.length).toBeGreaterThan(0);
	});

	test("names what the glyph depicts, not what lucide calls it", () => {
		expect(iconLabel("folder-kanban")).toBe("Project board");
		expect(iconLabel("gamepad-2")).toBe("Game controller");
		expect(iconLabel("shopping-cart")).toBe("Shopping cart");
	});

	test("no two icons share a name in any locale", () => {
		for (const locale of ["en", "de", "es", "fr", "ro", "ar"] as const) {
			const labels = ICON_NAMES.map((name) =>
				m[`icon_label_${name.replaceAll("-", "_")}` as "icon_label_check"](
					{},
					{ locale },
				),
			);
			expect(new Set(labels).size, `${locale} has duplicate icon names`).toBe(
				labels.length,
			);
		}
	});

	test("resolves in the caller's locale", () => {
		expect(m.icon_label_shopping_cart({}, { locale: "de" })).toBe(
			"Einkaufswagen",
		);
		expect(m.icon_label_graduation_cap({}, { locale: "fr" })).toBe(
			"Chapeau de diplômé",
		);
	});

	// The name can arrive from a stored list row, so a prototype key must not
	// resolve through the chain.
	test("an unknown or inherited key falls back to the key itself", () => {
		expect(iconLabel("not-an-icon")).toBe("not-an-icon");
		expect(iconLabel("constructor")).toBe("constructor");
		expect(iconLabel("toString")).toBe("toString");
	});
});
