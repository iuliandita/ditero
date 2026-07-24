import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

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

	// The signed-up session has no stored locale yet, so login reconcile is a
	// no-op and the switcher (post-auth mount) still reflects ar.
	await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
	await expect(page.getByTestId("language-switcher")).toContainText("العربية");
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
	await expect(page.getByTestId("language-switcher")).toContainText("English");
});
