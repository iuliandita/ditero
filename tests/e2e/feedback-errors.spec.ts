import { expect, test } from "@playwright/test";
import { goToSettings, signUp, uniqueEmail } from "./helpers.ts";

test("channel setup points to missing and invalid fields and disables an unavailable provider", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("channel-fields"));
	await goToSettings(page);
	await page.getByTestId("channel-ntfy-disclosure").click();
	await page.getByTestId("channel-ntfy-save").click();
	await expect(page.getByTestId("channel-ntfy-serverUrl")).toHaveAttribute(
		"aria-invalid",
		"true",
	);
	await expect(page.getByTestId("channel-ntfy-serverUrl")).toHaveAttribute(
		"aria-describedby",
		"channel-ntfy-serverUrl-error",
	);
	await expect(page.getByTestId("channel-ntfy-topic")).toHaveAttribute(
		"aria-invalid",
		"true",
	);
	await expect(page.getByTestId("channel-ntfy-topic")).toHaveAttribute(
		"aria-describedby",
		"channel-ntfy-topic-error",
	);
	await expect(page.locator("#channel-ntfy-serverUrl-error")).toHaveText(
		"This field is required.",
	);
	await expect(page.locator("#channel-ntfy-topic-error")).toHaveText(
		"This field is required.",
	);
	await page.getByTestId("channel-ntfy-serverUrl").fill("invalid-url");
	await page.getByTestId("channel-ntfy-topic").fill("has spaces");
	await page.getByTestId("channel-ntfy-save").click();
	await expect(page.locator("#channel-ntfy-serverUrl-error")).toHaveText(
		"Enter a complete http:// or https:// server URL.",
	);
	await expect(page.locator("#channel-ntfy-topic-error")).toHaveText(
		"Use 1 to 64 letters, numbers, underscores or hyphens.",
	);
	await expect(page.getByTestId("channel-telegram-disclosure")).toBeDisabled();
	await expect(page.getByTestId("channel-telegram-unavailable")).toHaveText(
		"That channel is not available yet.",
	);
});

test("TOTP reports transport and server failures separately from a rejected code", async ({
	page,
}) => {
	await page.route("**/api/auth/sign-in/email", (route) =>
		route.fulfill({ json: { twoFactorRedirect: true } }),
	);
	await page.goto("/");
	await page.getByTestId("email").fill("totp@example.test");
	await page.getByTestId("password").fill("pw-123456");
	await page.getByTestId("signin").click();
	await page.getByTestId("two-factor-code").fill("123456");
	let response = "network";
	await page.route("**/api/auth/two-factor/verify-totp", (route) => {
		if (response === "network") return route.abort("internetdisconnected");
		if (response === "server")
			return route.fulfill({ status: 503, json: { message: "Unavailable" } });
		return route.fulfill({
			status: 400,
			json: { code: "INVALID_CODE", message: "Invalid code" },
		});
	});
	await page.getByTestId("verify-totp").click();
	await expect(page.getByRole("alert")).toHaveText(
		"The server could not be reached. Check your connection and try again.",
	);
	response = "server";
	await page.getByTestId("verify-totp").click();
	await expect(page.getByRole("alert")).toHaveText(
		"The server could not verify your code. Try again.",
	);
	response = "invalid";
	await page.getByTestId("verify-totp").click();
	await expect(page.getByRole("alert")).toHaveText("That code is not correct.");
});
