import { expect, test } from "@playwright/test";
import ar from "../../messages/ar.json" with { type: "json" };
import de from "../../messages/de.json" with { type: "json" };
import en from "../../messages/en.json" with { type: "json" };
import es from "../../messages/es.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ro from "../../messages/ro.json" with { type: "json" };
import {
	goToSettings,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

const provider = {
	id: "saml-0123456789abcdef",
	name: "Corp SSO",
	protocol: "saml",
};

for (const sso of [[], [provider], undefined]) {
	test(`SAML button follows the server list: ${JSON.stringify(sso)}`, async ({
		page,
	}) => {
		await page.route("**/api/config", async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			await route.fulfill({
				json: { zeroURL: body.zeroURL, socialProviders: [], ssoProviders: sso },
			});
		});
		const config = page.waitForResponse("**/api/config");
		await page.goto("/");
		await config;
		if (sso?.length) {
			const button = page.getByTestId("signin-sso");
			await expect(button).toBeVisible();
			await expect(button).toHaveText("Continue with Corp SSO");
			let body: Record<string, unknown> = {};
			await page.route("**/api/auth/sign-in/sso", async (route) => {
				body = route.request().postDataJSON();
				await route.fulfill({
					status: 400,
					json: { code: "INVALID_RETURN_URL", message: "refused" },
				});
			});
			await button.click();
			await expect(page.getByRole("alert")).toBeVisible();
			expect(body).toEqual({
				providerId: provider.id,
				callbackURL: "/",
				errorCallbackURL: "/",
			});
		} else {
			await expect(page.getByTestId("signin-sso")).toHaveCount(0);
		}
		await page.getByTestId("signup-mode").click();
		await expect(page.getByTestId("signin-sso")).toHaveCount(sso?.length ?? 0);
		await expect(page.getByTestId("signin-passkey")).toBeVisible();
	});
}

for (const [locale, catalog] of Object.entries({ en, de, es, fr, ro, ar })) {
	test(`SAML button and callback errors are localized in ${locale}`, async ({
		page,
		context,
		baseURL,
	}) => {
		await context.addCookies([
			{ name: "PARAGLIDE_LOCALE", value: locale, url: baseURL as string },
		]);
		await page.route("**/api/config", async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			await route.fulfill({
				json: { zeroURL: body.zeroURL, ssoProviders: [provider] },
			});
		});
		await page.goto("/?error=account_not_linked");
		await expect(page.getByTestId("signin-sso")).toHaveText(
			catalog.login_continue_sso.replace("{name}", provider.name),
		);
		await expect(page.getByRole("alert")).toHaveText(
			catalog.auth_error_account_not_linked,
		);
		await expect(page.locator("html")).toHaveAttribute("lang", locale);
	});
}

test("a signed-in user links single sign-on explicitly", async ({ page }) => {
	await signUp(page, uniqueEmail("sso-link"));
	await waitWorkspaceReady(page);
	await page.route("**/api/config", async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		await route.fulfill({
			json: { zeroURL: body.zeroURL, ssoProviders: [provider] },
		});
	});
	await goToSettings(page);
	const panel = page.getByTestId("sso-link-panel");
	await expect(panel).toBeVisible();
	await expect(panel).toContainText("Corp SSO");
	let request: { query: string; body: Record<string, unknown> } | null = null;
	await page.route("**/api/auth/sign-in/sso**", async (route) => {
		request = {
			query: new URL(route.request().url()).search,
			body: route.request().postDataJSON(),
		};
		await route.fulfill({
			status: 400,
			json: { code: "INVALID_RETURN_URL", message: "stop here" },
		});
	});
	await panel.getByTestId("sso-link").click();
	await expect(panel.getByRole("alert")).toBeVisible();
	expect(request).toEqual({
		query: "?link=1",
		body: {
			providerId: provider.id,
			callbackURL: "/settings/security",
			errorCallbackURL: "/settings/security",
		},
	});
});

test("single sign-on settings stay hidden when none is configured", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("sso-none"));
	await waitWorkspaceReady(page);
	await goToSettings(page);
	await expect(page.getByTestId("add-passkey")).toBeVisible();
	await expect(page.getByTestId("sso-link-panel")).toHaveCount(0);
});
