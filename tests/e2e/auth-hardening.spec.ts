import { expect, test } from "@playwright/test";
import { currentTOTP } from "../totp.ts";

async function signUp(page: import("@playwright/test").Page, email: string) {
	await page.goto("/");
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill("pw-123456");
	await page.getByTestId("signup").click();
	await expect(page.getByTestId("workspace")).toBeVisible();
}

test("enrolls and signs in with a passkey", async ({ browser }) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	await cdp.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			protocol: "ctap2",
			transport: "internal",
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});

	await signUp(page, "passkey@test.invalid");
	await page.getByTestId("add-passkey").click();
	await expect(page.getByTestId("passkey-item")).toContainText("This device");

	await page.getByTestId("sign-out").click();
	await expect(page.getByTestId("signin-passkey")).toBeVisible();
	await page.getByTestId("signin-passkey").click();
	await expect(page.getByTestId("workspace")).toBeVisible();
	await context.close();
});

test("supports TOTP enrollment, step-up, recovery, and disable", async ({
	page,
}) => {
	const email = "totp@test.invalid";
	const password = "pw-123456";
	await signUp(page, email);
	await page.getByTestId("security-password").fill(password);
	await page.getByTestId("enable-2fa").click();

	const totpURI = await page.getByTestId("totp-uri").textContent();
	if (!totpURI) throw new Error("missing TOTP URI");
	const secret = new URL(totpURI).searchParams.get("secret");
	if (!secret) throw new Error("missing TOTP secret");
	const backupCode = await page
		.getByTestId("backup-code")
		.first()
		.textContent();
	if (!backupCode) throw new Error("missing backup code");

	await page.getByTestId("totp-code").fill(currentTOTP(secret));
	await page.getByTestId("verify-2fa").click();
	await expect(page.getByTestId("two-factor-status")).toHaveText("Enabled");

	await page.getByTestId("sign-out").click();
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill(password);
	await page.getByTestId("signin").click();
	await expect(page.getByTestId("two-factor-challenge")).toBeVisible();
	await page.getByTestId("two-factor-code").fill(currentTOTP(secret));
	await page.getByTestId("verify-totp").click();
	await expect(page.getByTestId("workspace")).toBeVisible();

	await page.getByTestId("sign-out").click();
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill(password);
	await page.getByTestId("signin").click();
	await page.getByTestId("backup-code-input").fill(backupCode);
	await page.getByTestId("verify-backup-code").click();
	await expect(page.getByTestId("workspace")).toBeVisible();

	await page.getByTestId("security-password").fill(password);
	await page.getByTestId("disable-2fa").click();
	await expect(page.getByTestId("two-factor-status")).toHaveText("Disabled");
});
