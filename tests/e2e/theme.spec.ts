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

	// Same-device persistence across a reload. This does NOT prove the choice
	// round-tripped through user_pref -- localStorage survives a reload, so the
	// boot hint alone would satisfy it. The cross-device test below is the one
	// that reaches the synced column.
	await selectTheme(page, m.theme_dark());
	await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
	await page.reload();
	await expect(page.getByTestId("workspace")).toBeVisible();
	await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
	await expect(await bodyBackground(page)).toBe(darkBg);
});

// #160: a second device has the same user_pref row and an empty localStorage.
// Dropping the boot hint reproduces that without a second browser context, and
// asserting it on the landing -- where ThemeSwitcher is not mounted -- is what
// makes it a test of the synced reader rather than of the switcher's own effect.
test("applies the synced theme on a device with no local hint", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("theme-sync"));
	await goToSettings(page);
	await selectTheme(page, m.theme_dark());
	await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
	const darkBg = await bodyBackground(page);

	// Key mirrors STORAGE_KEY in src/web/lib/theme.ts. Only that entry: a full
	// clear would also take Zero's client state with it.
	await page.evaluate(() => localStorage.removeItem("ditero-theme"));
	await page.reload();
	await expect(page.getByTestId("workspace")).toBeVisible();

	// The absence assertions are the point of the test, so they are paired with
	// a presence one: the shell is up and the Settings surface is provably not
	// mounted while the class check passes. ThemeMenu IS mounted here (sidebar
	// footer) and does read user_pref.theme, but it is a control only -- it
	// applies a class solely from setTheme, on a click that never happens in
	// this test -- so useSyncedTheme remains the only thing that could have put
	// the class back.
	await expect(page.getByTestId("theme-menu")).toBeVisible();
	await expect(page.getByTestId("settings-surface")).toHaveCount(0);
	await expect(page.getByTestId("theme-switcher")).toHaveCount(0);
	await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
	expect(await bodyBackground(page)).toBe(darkBg);
});

// Both ends of the menu lifecycle are waited on deliberately. Clicking the
// trigger again while the previous menu is still closing lets the role query
// resolve against the detached one, which fails as an unactionable click --
// the same race openRowMenu guards in affordances.spec. aria-expanded is the
// trigger's own state, so it cannot pass off a stale menu.
async function pickTheme(page: Page, label: string): Promise<void> {
	const trigger = page.getByTestId("theme-menu");
	await trigger.click();
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	await page.getByRole("menuitemradio", { name: label }).click();
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	// aria-expanded flips at the START of the close, while Radix's dismiss
	// guard is still live -- a reopening click inside that window toggles
	// straight back to closed. Wait for the content to actually detach.
	await expect(page.getByRole("menu")).toHaveCount(0);
}

// The reachability half: the same three states, one click from the sidebar
// rather than buried in Settings. Also pins that both controls read one source
// -- a choice made in the sidebar must be what Settings shows.
test("the sidebar theme menu sets the theme and agrees with Settings", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("theme-menu"));
	await expect(page.getByTestId("workspace")).toBeVisible();

	const menu = page.getByTestId("theme-menu");
	await expect(menu).toBeVisible();

	// Presence first, so the later absence assertion cannot pass vacuously.
	await pickTheme(page, m.theme_dark());
	await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
	const darkBg = await bodyBackground(page);

	await pickTheme(page, m.theme_light());
	await expect(page.locator("html")).not.toHaveClass(/(^|\s)dark(\s|$)/);
	expect(await bodyBackground(page)).not.toBe(darkBg);

	// One source of truth: the Settings select must already show the sidebar's
	// choice, not a stale default.
	await goToSettings(page);
	await expect(page.getByTestId("theme-switcher")).toContainText(
		m.theme_light(),
	);
});
