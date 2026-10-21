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

for (const [locale, catalog] of Object.entries({ en, de, es, fr, ro, ar })) {
	for (const [code, message] of [
		[
			"REGISTRATION_INVITE_REQUIRED",
			catalog.auth_error_registration_invite_required,
		],
		["REGISTRATION_DISABLED", catalog.auth_error_registration_disabled],
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
