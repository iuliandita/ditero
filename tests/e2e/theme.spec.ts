import { expect, type Page, test } from "@playwright/test";
import { m } from "../../src/paraglide/messages.js";
import { goToSettings, signUp, uniqueEmail } from "./helpers.ts";

// Light/dark/system control (plan 005): index.css already carries the .dark
// and prefers-color-scheme:dark blocks -- this exercises the switcher that
// finally puts a class on <html>. Asserts the COMPUTED background colour, not
// just the class: a class-list check alone would pass even if the
// @custom-variant wiring were broken (AGENTS.md's recurring failure shape).

async function selectTheme(page: Page, label: string): Promise<void> {
	await page.getByTestId("theme-switcher").click();
	await page.getByRole("option", { name: label }).click();
}

function bodyBackground(page: Page): Promise<string> {
	return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

test("switches light/dark/system and the computed background actually changes", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("theme"));
	await goToSettings(page);
	await expect(page.getByTestId("theme-switcher")).toBeVisible();

	// Presence assertion first: proves the html element can carry these classes
	// at all, so the later absence assertions are not vacuous.
	await selectTheme(page, m.theme_dark());
	await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
	await expect(page.locator("html")).not.toHaveClass(/(^|\s)light(\s|$)/);
	const darkBg = await bodyBackground(page);

	await selectTheme(page, m.theme_light());
	await expect(page.locator("html")).toHaveClass(/(^|\s)light(\s|$)/);
	await expect(page.locator("html")).not.toHaveClass(/(^|\s)dark(\s|$)/);
	const lightBg = await bodyBackground(page);

	expect(
		lightBg,
		"light and dark must resolve to different computed colours",
	).not.toBe(darkBg);

	await selectTheme(page, m.theme_system());
	await expect(page.locator("html")).not.toHaveClass(/(^|\s)dark(\s|$)/);
	await expect(page.locator("html")).not.toHaveClass(/(^|\s)light(\s|$)/);

	// Cross-device persistence: reload and confirm the choice round-tripped
	// through user_pref rather than only the in-page class toggle.
	await selectTheme(page, m.theme_dark());
	await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
	await page.reload();
	await expect(page.getByTestId("workspace")).toBeVisible();
	await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
	await expect(await bodyBackground(page)).toBe(darkBg);
});
