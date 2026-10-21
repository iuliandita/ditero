import {
	expect,
	type Page,
	request as playwrightRequest,
	test,
} from "@playwright/test";
import { configuredOrigin, uniqueEmail, webOrigin } from "./helpers.ts";

// #1172/#1173. The default app server has no SMTP, so the request form shows the
// SMTP-less refusal; the mail itself comes from the API-only SMTP server, which
// shares the database, and the page then runs on the default web app.
const MAIL_API = configuredOrigin("E2E_MAIL_API_URL");
const SMTP_CAPTURE = configuredOrigin("E2E_SMTP_HTTP_URL");
const OLD_PASSWORD = "old-password-123";
const NEW_PASSWORD = "new-password-456";

async function signInStatus(page: Page, email: string, password: string) {
	const origin = webOrigin();
	const response = await page.request.post(`${origin}/api/auth/sign-in/email`, {
		headers: { Origin: origin },
		data: { email, password },
	});
	return response.status();
}

async function mailedResetPath(email: string): Promise<string> {
	const deadline = Date.now() + 15_000;
	for (;;) {
		const { messages } = (await (
			await fetch(`${SMTP_CAPTURE}/_captured`)
		).json()) as { messages: string[] };
		const message = messages
			.map((raw) =>
				raw
					.replace(/=\r\n/g, "")
					.replace(/=([0-9A-F]{2})/g, (_, hex) =>
						String.fromCharCode(Number.parseInt(hex, 16)),
					),
			)
			.find((text) => text.includes(`To: ${email}`) || text.includes(email));
		const link = message?.match(
			/https?:\/\/[^\s/]+(\/api\/auth\/reset-password\/[^\s?]+\?callbackURL=\S+)/,
		);
		if (link) return link[1];
		if (Date.now() > deadline) throw new Error("no reset mail captured");
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

test("the sign-in page links to a reset request that explains a server without mail", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByTestId("login-forgot-password").click();
	await expect(page).toHaveURL(/\/reset-password$/);
	await page.getByTestId("reset-email").fill(uniqueEmail("reset-nomail"));
	await page.getByTestId("reset-request-submit").click();
	await expect(page.getByRole("alert")).toHaveText(
		"This server cannot send email, so password resets by email are unavailable. Ask your administrator to reset your password or to configure SMTP.",
	);
	await page.getByTestId("reset-back-to-sign-in").click();
	await expect(page.getByTestId("signin")).toBeVisible();
});

test("the mailed link sets a new password, reports what it removed and returns to sign-in", async ({
	page,
}) => {
	const origin = webOrigin();
	const email = uniqueEmail("reset-flow");
	const signUp = await page.request.post(`${origin}/api/auth/sign-up/email`, {
		headers: { Origin: origin },
		data: { email, password: OLD_PASSWORD, name: "Reset flow" },
	});
	expect(signUp.ok()).toBe(true);
	expect(await signInStatus(page, email, OLD_PASSWORD)).toBe(200);
	const token = await page.request.post(
		`${origin}/api/personal-access-tokens`,
		{
			headers: { Origin: origin },
			data: { name: "planted", access: "write" },
		},
	);
	expect(token.status(), await token.text()).toBe(201);
	const planted = ((await token.json()) as { data: { token: string } }).data
		.token;
	const meStatus = async () => {
		const api = await playwrightRequest.newContext();
		try {
			return (
				await api.get(`${origin}/api/v1/me`, {
					headers: { authorization: `Bearer ${planted}` },
				})
			).status();
		} finally {
			await api.dispose();
		}
	};
	expect(await meStatus()).toBe(200);

	const mailApi = await playwrightRequest.newContext();
	try {
		const requested = await mailApi.post(
			`${MAIL_API}/api/auth/request-password-reset`,
			{ data: { email, redirectTo: "/reset-password" } },
		);
		expect(requested.ok(), await requested.text()).toBe(true);
	} finally {
		await mailApi.dispose();
	}
	const path = await mailedResetPath(email);
	expect(path).toContain("callbackURL=%2Freset-password");

	// Better Auth checks the token and redirects to the web page with it.
	const checked = await page.request.get(`${origin}${path}`, {
		maxRedirects: 0,
	});
	expect(checked.status()).toBe(302);
	const target = new URL(checked.headers().location ?? "");
	expect(target.pathname).toBe("/reset-password");
	expect(target.searchParams.get("token")).toBeTruthy();

	await page.goto(`/reset-password${target.search}`);
	await expect(page).toHaveURL(/\/reset-password$/);
	await page.getByTestId("reset-new-password").fill(NEW_PASSWORD);
	await page.getByTestId("reset-confirm-password").fill("not-the-same-1");
	await page.getByTestId("reset-submit").click();
	await expect(page.getByRole("alert")).toHaveText(
		"The passwords don't match.",
	);
	await page.getByTestId("reset-confirm-password").fill(NEW_PASSWORD);
	await page.getByTestId("reset-submit").click();
	await expect(page.getByTestId("reset-done")).toBeVisible();
	await expect(page.getByTestId("reset-removed")).toHaveText("Access tokens");

	await page.getByTestId("reset-sign-in").click();
	await expect(page.getByTestId("signin")).toBeVisible();
	expect(await signInStatus(page, email, OLD_PASSWORD)).toBe(401);
	expect(await signInStatus(page, email, NEW_PASSWORD)).toBe(200);
	expect(await meStatus()).toBe(401);

	// The link is single-use.
	const reused = await page.request.get(`${origin}${path}`, {
		maxRedirects: 0,
	});
	expect(
		new URL(reused.headers().location ?? "").searchParams.get("error"),
	).toBe("INVALID_TOKEN");
});

test("an expired or used link explains itself and offers a new request", async ({
	page,
}) => {
	await page.goto("/reset-password?error=INVALID_TOKEN");
	await expect(page).toHaveURL(/\/reset-password$/);
	await expect(page.getByTestId("reset-link-invalid")).toHaveText(
		"This reset link is invalid, expired or already used. Request a new one below.",
	);
	await expect(page.getByTestId("reset-email")).toBeVisible();
});
