import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import type { Locale } from "../../src/domain/locale.ts";
import { m } from "../../src/paraglide/messages.js";
import { goToSettings } from "./helpers.ts";

// M-i18n language switcher: pre-auth (Login) + post-auth (settings) mounts,
// user_pref.locale persistence + round-trip across a reload, dir/lang
// application, and the axe gate in RTL (design 2.14: zero serious/critical).
test.describe.configure({ retries: 2, timeout: 60_000 });

const PASSWORD = "pw-123456";
const SIGNUP_TIMEOUT = 30_000;

let emailSeq = 0;
function uniqueEmail(prefix: string): string {
	emailSeq += 1;
	return `${prefix}-${Date.now()}-${emailSeq}@t.dev`;
}

// Freeze animations so axe samples the settled frame (matches focus.spec).
async function expectNoSeriousA11y(page: Page, surface: string): Promise<void> {
	await page.addStyleTag({
		content:
			"*,*::before,*::after{animation:none!important;transition:none!important}",
	});
	const { violations } = await new AxeBuilder({ page }).analyze();
	const serious = violations.filter(
		(v) => v.impact === "serious" || v.impact === "critical",
	);
	if (serious.length > 0)
		console.error(
			`a11y[${surface}] serious/critical:`,
			JSON.stringify(
				serious.map((v) => ({ id: v.id, nodes: v.nodes.length })),
				null,
				2,
			),
		);
	expect(serious, `serious/critical a11y violations on ${surface}`).toEqual([]);
}

async function selectLanguage(page: Page, nativeName: string): Promise<void> {
	await page.getByTestId("language-switcher").click();
	await page.getByRole("option", { name: nativeName }).click();
}

// Switch via the real switcher (writes the cookie the strategy chain reads
// first) and wait out Paraglide's reload, so nothing here depends on whatever
// navigator.languages a cold profile happens to advertise.
async function switchTo(
	page: Page,
	nativeName: string,
	locale: Locale,
	dir: "ltr" | "rtl",
): Promise<void> {
	const reloaded = page.waitForEvent("load");
	await selectLanguage(page, nativeName);
	await reloaded;
	await expect(page.locator("html")).toHaveAttribute("lang", locale);
	await expect(page.locator("html")).toHaveAttribute("dir", dir);
}

// Expected text comes from the compiled catalog rather than a literal, so the
// assertion tracks the translation instead of pinning a copy of it. The DOM
// side still travels the whole chain (catalog -> compiler -> strategy -> render),
// so this is not m() === m(). The differs-from-English guard is what stops it
// degenerating: without it, a switcher that silently no-ops would still pass
// every locale whose string happened to match the base.
const LOGIN_SURFACE = [
	["signup", m.login_signup] as const,
	["signin", m.login_signin] as const,
	["signin-passkey", m.login_signin_passkey] as const,
];

async function expectLoginRendersCatalog(
	page: Page,
	locale: Locale,
): Promise<void> {
	for (const [testId, message] of LOGIN_SURFACE) {
		const translated = message({}, { locale });
		expect(
			translated,
			`${testId} is untranslated in ${locale}; the assertion below would be vacuous`,
		).not.toBe(message({}, { locale: "en" }));
		await expect(page.getByTestId(testId)).toHaveText(translated);
	}
}

test("renders the German catalog with lang=de and dir=ltr", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.getByTestId("language-switcher")).toBeVisible();

	await switchTo(page, "Deutsch", "de", "ltr");
	await expectLoginRendersCatalog(page, "de");
	await expectNoSeriousA11y(page, "login (de)");
});

test("renders the Arabic catalog with lang=ar and dir=rtl", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.getByTestId("language-switcher")).toBeVisible();

	await switchTo(page, "العربية", "ar", "rtl");
	await expectLoginRendersCatalog(page, "ar");
	await expectNoSeriousA11y(page, "login (ar)");
});

test("switches to Arabic pre-auth, applies RTL, persists post-auth and round-trips", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.getByTestId("language-switcher")).toBeVisible();

	// Pre-auth: reload-based setLocale (Paraglide default) is the chosen
	// strategy -- m.*() calls are not reactive, so only a reload guarantees the
	// whole page (not just the switcher) reflects the new locale.
	const reloaded = page.waitForEvent("load");
	await selectLanguage(page, "العربية");
	await reloaded;

	await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
	await expect(page.locator("html")).toHaveAttribute("lang", "ar");
	await expectNoSeriousA11y(page, "login (rtl)");

	// Sign up while ar is active; data-testid selectors are locale-independent.
	await page.getByTestId("email").fill(uniqueEmail("locale"));
	await page.getByTestId("password").fill(PASSWORD);
	await page.getByTestId("signup").click();
	await expect(page.getByTestId("workspace")).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
	await goToSettings(page);

	// The signed-up session has no stored locale yet, so login reconcile is a
	// no-op and the switcher (post-auth mount) still reflects ar.
	await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
	await expect(page.getByTestId("language-switcher")).toContainText("العربية");
	// A real heading on the authed surface, so the catalog assertion covers a
	// post-auth mount and not just the pre-auth one.
	await expect(page.locator("#security-heading")).toHaveText(
		m.security_heading({}, { locale: "ar" }),
	);
	// The back chevron mirrors: the glyph means "reverse", and reverse is
	// rightward when the reading direction is. Asserted on the computed rotate
	// the rtl: variant emits, not on the class name -- a variant that compiled
	// to a never-matching selector leaves the class in the DOM regardless.
	const backGlyph = page.getByTestId("settings-back").locator("svg");
	await expect(backGlyph).toHaveCSS("rotate", "180deg");
	// A collapsed disclosure chevron is directional the same way: CSS Counter
	// Styles 3 defines disclosure-closed as end-pointing (U+25B8 in ltr, U+25C2
	// in rtl) and disclosure-open as down-pointing in both, so only the closed
	// state mirrors. This row is closed on mount.
	const disclosureGlyph = page
		.getByTestId("channel-ntfy-disclosure")
		.locator("svg");
	await expect(disclosureGlyph).toHaveCSS("rotate", "180deg");
	await expectNoSeriousA11y(page, "settings (rtl)");

	// Switching post-auth persists to user_pref.locale (not just the client
	// strategy chain) -- verified by a reload round-trip below.
	const reloadedPostAuth = page.waitForEvent("load");
	await selectLanguage(page, "English");
	await reloadedPostAuth;
	await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
	await expect(page.locator("html")).toHaveAttribute("lang", "en");

	await page.reload();
	await expect(page.getByTestId("workspace")).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
	await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
	await expect(page.locator("html")).toHaveAttribute("lang", "en");
	await goToSettings(page);
	await expect(page.getByTestId("language-switcher")).toContainText("English");
	// The LTR half of the pair: the same node the RTL assertion found, proving
	// that assertion was not passing against an element that always rotates.
	await expect(backGlyph).toHaveCSS("rotate", "none");
	await expect(disclosureGlyph).toHaveCSS("rotate", "none");
});
