import { expect, test } from "@playwright/test";
import {
	configuredOrigin,
	goToSettings,
	signUp,
	uniqueEmail,
	webOrigin,
} from "./helpers.ts";

test.describe.configure({ timeout: 120_000 });

for (const unavailable of ["insecure", "missing-api"] as const) {
	test(`passkey sign-in explains ${unavailable} browser support`, async ({
		page,
	}) => {
		await page.addInitScript((reason) => {
			if (reason === "insecure")
				Object.defineProperty(window, "isSecureContext", { value: false });
			else
				Object.defineProperty(window, "PublicKeyCredential", {
					value: undefined,
				});
		}, unavailable);
		await page.goto(webOrigin());
		await page.getByTestId("signin-passkey").click();
		await expect(page.getByRole("alert")).toHaveText(
			"Passkeys require HTTPS or localhost and a browser with WebAuthn support.",
		);
	});
}

test("passkey registration explains a missing WebAuthn API", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("passkey-unavailable"));
	await page.evaluate(() =>
		Object.defineProperty(window, "PublicKeyCredential", { value: undefined }),
	);
	await goToSettings(page);
	await page.getByTestId("add-passkey").click();
	await expect(page.getByRole("alert")).toHaveText(
		"Passkeys require HTTPS or localhost and a browser with WebAuthn support.",
	);
});

test("sync details identify the configured unreachable address", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("sync-address"));
	const unreachable = new URL(configuredOrigin("E2E_PUBLIC_ZERO_URL"));
	unreachable.port = "1";
	await page.route("**/api/config", (route) =>
		route.fulfill({ json: { zeroURL: unreachable.href } }),
	);
	await page.reload();
	const indicator = page.getByTestId("sync-indicator");
	await expect(indicator).toBeVisible();
	await indicator.click();
	await expect(page.getByTestId("sync-popover")).toContainText(
		`Sync address: ${unreachable.href}`,
	);
});
