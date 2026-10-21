import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { signUp, uniqueEmail, waitWorkspaceReady } from "./helpers.ts";

async function cachePublicShell(page: Page) {
	expect(process.env.E2E_BROWSER_MODE, "offline shell needs a built app").toBe(
		"compiled",
	);
	await page.evaluate(async () => {
		await navigator.serviceWorker.register("/sw.js", { type: "module" });
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller)
			await new Promise<void>((resolve) =>
				navigator.serviceWorker.addEventListener(
					"controllerchange",
					() => resolve(),
					{ once: true },
				),
			);
	});
}

for (const locale of ["en", "ar"] as const) {
	test(`offline reload explains the connection requirement and recovers automatically (${locale})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await signUp(page, uniqueEmail("needs-connection"));
		await waitWorkspaceReady(page);
		await cachePublicShell(page);
		await context.addCookies([
			{ name: "PARAGLIDE_LOCALE", value: locale, url: page.url() },
		]);
		try {
			await context.setOffline(true);
			await page.reload();
			const heading = page.getByRole("heading", {
				level: 1,
				name:
					locale === "en"
						? "Ditero needs a connection to open"
						: "يحتاج Ditero إلى اتصال ليفتح",
			});
			await expect(heading).toBeVisible();
			await expect(heading).toBeFocused();
			await expect(page.getByTestId("signin")).toHaveCount(0);
			await expect(page.getByTestId("workspace-switcher")).toHaveCount(0);
			await expect(page.locator("html")).toHaveAttribute(
				"dir",
				locale === "ar" ? "rtl" : "ltr",
			);
			const retry = page.getByRole("button", {
				name: locale === "en" ? "Retry" : "حاول مرة أخرى",
				exact: true,
			});
			await retry.click();
			await expect(heading).toBeVisible();
			const { violations } = await new AxeBuilder({ page }).analyze();
			expect(
				violations.filter(
					(v) => v.impact === "serious" || v.impact === "critical",
				),
			).toEqual([]);
			const cachedPaths = await page.evaluate(async () => {
				const paths: string[] = [];
				for (const name of await caches.keys())
					for (const request of await (await caches.open(name)).keys())
						paths.push(new URL(request.url).pathname);
				return paths;
			});
			expect(cachedPaths).toContain("/index.html");
			expect(cachedPaths.some((path) => path.startsWith("/assets/"))).toBe(
				true,
			);
			expect(cachedPaths.filter((path) => path.startsWith("/api/"))).toEqual(
				[],
			);
			await context.setOffline(false);
			await waitWorkspaceReady(page);
			await expect(heading).toHaveCount(0);
		} finally {
			await context.setOffline(false);
		}
	});
}

for (const endpoint of ["bootstrap", "config", "auth/token"]) {
	test(`connection-level ${endpoint} failure keeps a retryable startup page`, async ({
		page,
	}) => {
		test.setTimeout(90_000);
		await signUp(page, uniqueEmail("bootstrap-connection"));
		await waitWorkspaceReady(page);
		let attempts = 0;
		await page.route(`**/api/${endpoint}`, (route) => {
			attempts++;
			return route.abort("connectionrefused");
		});
		await page.reload();
		const heading = page.getByRole("heading", {
			name: "Ditero needs a connection to open",
		});
		await expect(heading).toBeVisible();
		expect(await page.evaluate(() => navigator.onLine)).toBe(true);
		await expect(page.getByTestId("signin")).toHaveCount(0);
		await expect.poll(() => attempts).toBeGreaterThanOrEqual(2);
		await page.unroute(`**/api/${endpoint}`);
		await page.getByRole("button", { name: "Retry", exact: true }).click();
		await waitWorkspaceReady(page);
		await expect(heading).toHaveCount(0);
	});
}
