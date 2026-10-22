import { expect, test } from "@playwright/test";
import ar from "../../messages/ar.json" with { type: "json" };
import de from "../../messages/de.json" with { type: "json" };
import en from "../../messages/en.json" with { type: "json" };
import es from "../../messages/es.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ro from "../../messages/ro.json" with { type: "json" };

for (const providers of [[], ["google"], undefined]) {
	test(`social sign-in availability: ${JSON.stringify(providers)}`, async ({
		page,
	}) => {
		await page.route("**/api/config", async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			await route.fulfill({
				json: { zeroURL: body.zeroURL, socialProviders: providers },
			});
		});
		const config = page.waitForResponse("**/api/config");
		await page.goto("/");
		await config;
		if (providers?.includes("google")) {
			await expect(page.getByTestId("signin-google")).toBeVisible();
			await page.route("**/api/auth/sign-in/social", async (route) => {
				expect(route.request().postDataJSON()).toMatchObject({
					provider: "google",
					errorCallbackURL: new URL("/", page.url()).href,
				});
				await route.fulfill({ json: { error: "test" }, status: 400 });
			});
			await page.getByTestId("signin-google").click();
			await expect(page.getByRole("alert")).toBeVisible();
		} else {
			await expect(page.getByTestId("signin-google")).toHaveCount(0);
		}
		await page.getByTestId("signup-mode").click();
		await expect(page.getByTestId("signin-google")).toHaveCount(
			providers?.includes("google") ? 1 : 0,
		);
		await expect(page.getByTestId("signin-passkey")).toBeVisible();
	});
}

test("server-listed providers render in order and start their own sign-in", async ({
	page,
}) => {
	await page.route("**/api/config", async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		await route.fulfill({
			json: {
				zeroURL: body.zeroURL,
				socialProviders: ["family", "discord", "github", "google"],
				oidcProviders: [{ id: "family", name: "Family SSO", icon: "shield" }],
			},
		});
	});
	const config = page.waitForResponse("**/api/config");
	await page.goto("/");
	await config;
	const buttons = page.locator(
		'[data-testid^="signin-"]:not([data-testid="signin-passkey"])',
	);
	await expect(buttons).toHaveCount(4);
	await expect(buttons.nth(0)).toHaveAttribute("data-testid", "signin-google");
	await expect(buttons.nth(1)).toHaveAttribute("data-testid", "signin-github");
	await expect(buttons.nth(2)).toHaveAttribute("data-testid", "signin-discord");
	await expect(buttons.nth(3)).toHaveAttribute("data-testid", "signin-family");
	await expect(page.getByTestId("signin-github")).toHaveText(
		en.login_continue_with.replace("{provider}", "GitHub"),
	);
	await expect(page.getByTestId("signin-family")).toHaveText(
		en.login_continue_with.replace("{provider}", "Family SSO"),
	);
	await expect(page.getByTestId("signin-microsoft")).toHaveCount(0);

	let requested: unknown;
	await page.route("**/api/auth/sign-in/social", async (route) => {
		requested = route.request().postDataJSON();
		await route.fulfill({ json: { error: "test" }, status: 400 });
	});
	await page.getByTestId("signin-family").click();
	await expect(page.getByRole("alert")).toBeVisible();
	expect(requested).toMatchObject({
		provider: "family",
		errorCallbackURL: new URL("/", page.url()).href,
	});
});

for (const [locale, catalog] of Object.entries({ en, de, es, fr, ro, ar })) {
	test(`provider button label is localized in ${locale}`, async ({
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
				json: { zeroURL: body.zeroURL, socialProviders: ["github"] },
			});
		});
		await page.goto("/");
		await expect(page.getByTestId("signin-github")).toHaveText(
			catalog.login_continue_with.replace("{provider}", "GitHub"),
		);
	});
}

for (const [locale, catalog] of Object.entries({ en, de, es, fr, ro, ar })) {
	for (const [code, message] of [
		[
			"REGISTRATION_INVITE_REQUIRED",
			catalog.auth_error_registration_invite_required,
		],
		["REGISTRATION_DISABLED", catalog.auth_error_registration_disabled],
		["REGISTRATION_RELAY_EMAIL", catalog.auth_error_registration_relay_email],
		["email_not_found", catalog.auth_error_email_not_found],
		["account_not_linked", catalog.auth_error_account_not_linked],
		[
			"account_already_linked_to_different_user",
			catalog.auth_error_account_already_linked,
		],
	]) {
		test(`social sign-in callback localizes ${code} in ${locale}`, async ({
			page,
			context,
			baseURL,
		}) => {
			await context.addCookies([
				{ name: "PARAGLIDE_LOCALE", value: locale, url: baseURL as string },
			]);
			await page.goto(`/?error=${code}`);
			await expect(page.getByRole("alert")).toHaveText(message);
			await expect(page.locator("html")).toHaveAttribute("lang", locale);
		});
	}
}
