import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { configuredOrigin, signUp, uniqueEmail, webOrigin } from "./helpers.ts";

test.use({
	screenshot: "off",
	trace: { mode: "retain-on-failure", screenshots: false },
});

test("system browser retains the native grant and approves only after explicit consent", async ({
	page,
	context,
	playwright,
}) => {
	test.setTimeout(120_000);
	const credentialsPath = process.env.NATIVE_AUTH_UI_CREDENTIALS;
	const captureDir = process.env.NATIVE_AUTH_CAPTURE_DIR;
	if (captureDir && !credentialsPath)
		throw new Error("Captures require the canonical UI fixture credentials");
	let credentials: { email: string; password: string };
	if (credentialsPath)
		credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
	else {
		credentials = { email: uniqueEmail("native-maya"), password: "pw-123456" };
		await signUp(page, credentials.email);
		const named = await page.request.post("/api/auth/update-user", {
			headers: { Origin: new URL(page.url()).origin },
			data: { name: "Maya Chen" },
		});
		expect(named.ok()).toBe(true);
		await context.clearCookies();
	}
	const web = webOrigin();
	const api = await playwright.request.newContext({
		baseURL: configuredOrigin("E2E_API_URL"),
	});
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	let approvals = 0;
	let zeroRequests = 0;
	let zeroSockets = 0;
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (path === "/api/native/grants/approve") approvals++;
		if (path.startsWith("/api/zero/") || path === "/api/auth/token")
			zeroRequests++;
	});
	page.on("websocket", (socket) => {
		if (/\/sync\/v\d+\/connect/.test(socket.url())) zeroSockets++;
	});
	try {
		const create = await api.post("/api/native/grants", {
			data: { challenge, deviceLabel: "Maya's desktop" },
		});
		expect(create.status()).toBe(200);
		const { grantId } = (await create.json()) as { grantId: string };
		const authorize = `/native/authorize?grantId=${grantId}`;
		await page.goto(authorize);
		await expect(page.getByTestId("signin")).toBeVisible();
		await page.getByTestId("email").fill(credentials.email);
		await page.getByTestId("password").fill(credentials.password);
		await Promise.all([
			page.waitForEvent("domcontentloaded"),
			page.getByTestId("signin").click(),
		]);
		const panel = page.getByTestId("native-authorize");
		await expect(panel).toBeVisible();
		await expect(page).toHaveURL(`${web}${authorize}`);
		await expect(panel.getByText("Maya Chen", { exact: true })).toBeVisible();
		await expect(
			panel.getByText("Maya's desktop", { exact: true }),
		).toBeVisible();
		await expect(
			panel.getByText(credentials.email, { exact: true }),
		).toBeVisible();
		expect(
			(
				await api.post("/api/native/grants/exchange", {
					data: { grantId, verifier },
				})
			).status(),
		).toBe(409);
		expect(approvals).toBe(0);
		expect(zeroRequests).toBe(0);
		expect(zeroSockets).toBe(0);
		const session = (await (
			await page.request.get("/api/auth/get-session")
		).json()) as { user: { id: string } };
		const accessible = async () => {
			const results = await new AxeBuilder({ page })
				.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
				.analyze();
			expect(
				results.violations.filter(
					(item) => item.impact === "serious" || item.impact === "critical",
				),
			).toEqual([]);
		};
		await accessible();
		if (captureDir) {
			await mkdir(captureDir, { recursive: true });
			const variants = [
				{
					name: "desktop-light",
					width: 1440,
					theme: "light",
					locale: "en",
					large: false,
				},
				{
					name: "desktop-dark",
					width: 1440,
					theme: "dark",
					locale: "en",
					large: false,
				},
				{
					name: "mobile-light",
					width: 390,
					theme: "light",
					locale: "en",
					large: false,
				},
				{
					name: "mobile-dark",
					width: 390,
					theme: "dark",
					locale: "en",
					large: false,
				},
				{
					name: "mobile-large-high-contrast",
					width: 390,
					theme: "dark",
					locale: "en",
					large: true,
				},
				{
					name: "mobile-german",
					width: 390,
					theme: "light",
					locale: "de",
					large: false,
				},
				{
					name: "mobile-arabic",
					width: 390,
					theme: "dark",
					locale: "ar",
					large: false,
				},
			];
			const captureNames = process.env.NATIVE_AUTH_CAPTURE_VARIANTS?.split(",");
			if (captureNames)
				expect(
					captureNames.every((name) => variants.some((v) => v.name === name)),
				).toBe(true);
			for (const variant of variants.filter(
				(v) => !captureNames || captureNames.includes(v.name),
			)) {
				await page.setViewportSize({
					width: variant.width,
					height: variant.width === 390 ? 844 : 900,
				});
				await context.addCookies([
					{ name: "PARAGLIDE_LOCALE", value: variant.locale, url: web },
				]);
				await page.evaluate(
					({ variant, userId }) => {
						localStorage.setItem("PARAGLIDE_LOCALE", variant.locale);
						localStorage.setItem("ditero-theme", variant.theme);
						localStorage.setItem(
							`ditero.display.${userId}`,
							JSON.stringify({
								readingSize: variant.large ? "large" : "standard",
								highContrast: variant.large,
							}),
						);
					},
					{ variant, userId: session.user.id },
				);
				await page.reload();
				await expect(page.getByTestId("native-authorize-allow")).toBeVisible();
				await expect(page.locator("html")).toHaveClass(
					new RegExp(variant.theme),
				);
				await expect(page.locator("html")).toHaveAttribute(
					"lang",
					variant.locale,
				);
				await expect(page.locator("html")).toHaveAttribute(
					"dir",
					variant.locale === "ar" ? "rtl" : "ltr",
				);
				await expect(page.locator("html")).toHaveAttribute(
					"data-reading-size",
					variant.large ? "large" : "standard",
				);
				await expect(page.locator("html")).toHaveAttribute(
					"data-high-contrast",
					String(variant.large),
				);
				expect(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= window.innerWidth,
					),
				).toBe(true);
				await accessible();
				await page.screenshot({
					path: join(captureDir, `${variant.name}.png`),
					fullPage: true,
				});
			}
			await context.addCookies([
				{ name: "PARAGLIDE_LOCALE", value: "en", url: web },
			]);
			await page.evaluate(() => localStorage.setItem("PARAGLIDE_LOCALE", "en"));
			await page.reload();
		}
		expect(approvals).toBe(0);
		expect(zeroRequests).toBe(0);
		expect(zeroSockets).toBe(0);
		const allow = page.getByTestId("native-authorize-allow");
		await allow.focus();
		await expect(allow).toBeFocused();
		await allow.press("Enter");
		await expect(page.getByTestId("native-authorize-approved")).toContainText(
			"Request approved",
		);
		await expect(page.getByTestId("native-authorize-approved")).toContainText(
			"Return to the app to finish signing in.",
		);
		await expect(
			page.getByTestId("native-authorize-approved"),
		).not.toContainText(/connected/i);
		expect(approvals).toBe(1);
		const exchange = await api.post("/api/native/grants/exchange", {
			data: { grantId, verifier },
		});
		expect(exchange.status()).toBe(200);
		expect(await exchange.json()).toMatchObject({ userId: session.user.id });
		expect(
			(
				await api.post("/api/native/grants/exchange", {
					data: { grantId, verifier },
				})
			).status(),
		).toBe(400);
		await page.goto(authorize);
		await expect(page.getByTestId("native-authorize-invalid")).toBeVisible();
		await expect(page.getByRole("alert")).toBeVisible();
		await expect(page.getByTestId("native-authorize-allow")).toHaveCount(0);
		await page.goto("/native/authorize?grantId=malformed");
		await expect(page.getByTestId("native-authorize-invalid")).toBeVisible();
		await expect(page.getByRole("alert")).toBeVisible();
		await expect(page.getByTestId("native-authorize-allow")).toHaveCount(0);
		expect(approvals).toBe(1);
		expect(zeroRequests).toBe(0);
		expect(zeroSockets).toBe(0);
	} finally {
		await api.dispose();
	}
});
