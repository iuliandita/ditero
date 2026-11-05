import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, expect, test } from "vitest";
import * as runtime from "../../paraglide/runtime.js";
import { isolated, NameList } from "./bidi.tsx";

const originalGetLocale = runtime.getLocale;
afterAll(() => runtime.overwriteGetLocale(originalGetLocale));

test("isolated wraps only the interpolated value", () => {
	expect(
		renderToStaticMarkup(<>{isolated((v) => `Added to ${v}.`, "Groceries")}</>),
	).toBe("Added to <bdi>Groceries</bdi>.");
});

test.each([
	["en", "<bdi>Alex Reed</bdi> and <bdi>Casey Lane</bdi>"],
	["ar", "<bdi>Alex Reed</bdi> و<bdi>Casey Lane</bdi>"],
])("NameList isolates each name in %s", (locale, markup) => {
	runtime.overwriteGetLocale(() => locale as "en");
	expect(
		renderToStaticMarkup(<NameList names={["Alex Reed", "Casey Lane"]} />),
	).toBe(markup);
});
