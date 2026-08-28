import { expect, test } from "@playwright/test";
import { currentTOTP } from "../totp.ts";
import { goToSettings } from "./helpers.ts";

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
	await goToSettings(page);
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
	await goToSettings(page);

	await page.getByTestId("sign-out").click();
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill(password);
	await page.getByTestId("signin").click();
	await page.getByTestId("backup-code-input").fill(backupCode);
	await page.getByTestId("verify-backup-code").click();
	await expect(page.getByTestId("workspace")).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
	await goToSettings(page);

	await page.getByTestId("security-password").fill(password);
	await page.getByTestId("disable-2fa").click();
	await expect(page.getByTestId("two-factor-status")).toHaveText("Disabled", {
		timeout: ENROLL_TIMEOUT,
	});
});

// #193: two different 403s used to render the same flat "sign up failed".
// The app's own same-origin guard (src/auth/auth.ts) runs ahead of Better Auth,
// so this is the failure a self-hoster meets first: the browser reached the app
// on an address that is not BETTER_AUTH_URL and is not in TRUSTED_ORIGINS. The
// suite's servers trust localhost:5173 only; the request is re-sent with another
// origin rather than fulfilled, so the 403 is the real guard's answer.
test("an untrusted origin says so instead of failing blankly", async ({
	page,
}) => {
	// Re-issued from node rather than route.continue(): Chromium will not let a
	// page rewrite its own Origin. The server still produces the response.
	await page.route("**/api/auth/sign-up/email", async (route) => {
		const response = await route.fetch({
			headers: { ...route.request().headers(), origin: "http://10.0.0.5:5173" },
		});
		await route.fulfill({ response });
	});
	await page.goto("/");
	await page.getByTestId("email").fill(`origin-${Date.now()}@t.dev`);
	await page.getByTestId("password").fill("pw-123456");
	await page.getByTestId("signup").click();

	await expect(
		page.getByText(
			"This address is not trusted by the server. Ask the operator to add it to the instance's trusted origins.",
		),
	).toBeVisible({ timeout: ENROLL_TIMEOUT });
	await expect(page.getByText("sign up failed")).toHaveCount(0);
});

// The gate needs an instance in bootstrap/closed mode, which this suite's
// servers are not (DITERO_REGISTRATION_MODE=open), so the refusal is injected.
// The body is not invented: tests/integration/auth-error-codes.test.ts pins
// that the server emits exactly this code and message.
test("the invite-only gate names itself instead of failing blankly", async ({
	page,
}) => {
	await page.route("**/api/auth/sign-up/email", (route) =>
		route.fulfill({
			status: 403,
			contentType: "application/json",
			body: JSON.stringify({
				message: "Registration requires an invitation",
				code: "REGISTRATION_INVITE_REQUIRED",
			}),
		}),
	);
	await page.goto("/");
	await page.getByTestId("email").fill(`gate-${Date.now()}@t.dev`);
	await page.getByTestId("password").fill("pw-123456");
	await page.getByTestId("signup").click();

	await expect(
		page.getByText(
			"This instance only accepts new accounts by invitation. Ask an admin to invite you.",
		),
	).toBeVisible({ timeout: ENROLL_TIMEOUT });
	await expect(page.getByText("sign up failed")).toHaveCount(0);
});
