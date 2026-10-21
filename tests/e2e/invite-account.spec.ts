import { expect, test } from "@playwright/test";
import { signUp, uniqueEmail } from "./helpers.ts";

test("wrong-account invite explains the mismatch and preserves the invite through sign-out", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("invite-account"));
	await page.route("**/api/invite/preview", (route) => {
		expect(route.request().method()).toBe("POST");
		expect(route.request().postDataJSON()).toEqual({ token: "account-test" });
		return route.fulfill({
			json: { valid: true, workspaceName: "Invite account", email: null },
		});
	});
	await page.route("**/api/invite/accept", (route) =>
		route.fulfill({ status: 403, body: "email_mismatch" }),
	);
	await page.goto("/accept?token=account-test");
	await page.getByTestId("accept-join").click();
	await expect(page.getByRole("alert")).toHaveText(
		"This invite is for another email address. Sign out, then sign in with the account it was sent to.",
	);
	await expect(page.getByTestId("accept-join")).toHaveCount(0);
	await page.getByTestId("accept-switch-account").click();
	await expect(page.getByTestId("accept-email")).toBeVisible();
	await expect(page.getByTestId("accept-submit")).toBeVisible();
	await expect(page).toHaveURL(/account-test/);
});
