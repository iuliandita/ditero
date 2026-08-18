import { expect, test } from "@playwright/test";
import { currentTOTP } from "../totp.ts";

// Every assertion here that waits on an auth round trip carries an explicit
// budget: the default only ever fit while this file happened to run first, so
// the test asserted its own position in the suite as much as the behaviour.
// SIGNUP_TIMEOUT is the suite-wide budget for "the app is booted and its initial
// Zero sync has landed"; ENROLL_TIMEOUT is the post-interaction budget the other
// specs use, and covers the WebAuthn virtual-authenticator ceremony plus the
// registration round trip and the list re-render.
test.describe.configure({ timeout: 90_000 });
const SIGNUP_TIMEOUT = 30_000;
const ENROLL_TIMEOUT = 15_000;

async function signUp(page: import("@playwright/test").Page, email: string) {
	await page.goto("/");
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill("pw-123456");
	await page.getByTestId("signup").click();
	await expect(page.getByTestId("workspace")).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
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
	await expect(page.getByTestId("passkey-item")).toContainText("This device", {
		timeout: ENROLL_TIMEOUT,
	});

	await page.getByTestId("sign-out").click();
	await expect(page.getByTestId("signin-passkey")).toBeVisible();
	await page.getByTestId("signin-passkey").click();
	await expect(page.getByTestId("workspace")).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
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
	await expect(page.getByTestId("two-factor-status")).toHaveText("Enabled", {
		timeout: ENROLL_TIMEOUT,
	});

	await page.getByTestId("sign-out").click();
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill(password);
	await page.getByTestId("signin").click();
	await expect(page.getByTestId("two-factor-challenge")).toBeVisible({
		timeout: ENROLL_TIMEOUT,
	});
	await page.getByTestId("two-factor-code").fill(currentTOTP(secret));
	await page.getByTestId("verify-totp").click();
	await expect(page.getByTestId("workspace")).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});

	await page.getByTestId("sign-out").click();
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill(password);
	await page.getByTestId("signin").click();
	await page.getByTestId("backup-code-input").fill(backupCode);
	await page.getByTestId("verify-backup-code").click();
	await expect(page.getByTestId("workspace")).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});

	await page.getByTestId("security-password").fill(password);
	await page.getByTestId("disable-2fa").click();
	await expect(page.getByTestId("two-factor-status")).toHaveText("Disabled", {
		timeout: ENROLL_TIMEOUT,
	});
});
