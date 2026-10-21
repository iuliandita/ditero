import { expect, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import {
	goToSettings,
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";
import {
	holdIdlePersistence,
	installPersistenceControls,
} from "./zero-persistence-controls.ts";

async function serverHasTask(title: string): Promise<boolean> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		const result = await pool.query("select 1 from task where title = $1", [
			title,
		]);
		return (result.rowCount ?? 0) > 0;
	} finally {
		await pool.end();
	}
}

async function cachePublicShell(page: Page) {
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

async function expectOfflineRefused(page: Page) {
	await page.reload();
	await expect(page.getByRole("alert")).toContainText("Connect to the server");
	await expect(page.getByTestId("offline-session")).toHaveCount(0);
	await expect(sidebarLists(page)).toHaveCount(0);
}

test("offline reload restores only cached account data and reconciles queued edits before refusing a revoked session", async ({
	page,
	context,
}) => {
	test.setTimeout(120_000);
	expect(
		process.env.E2E_BROWSER_MODE,
		"offline reload requires the compiled PWA fixture",
	).toBe("compiled");
	await context.addInitScript(installPersistenceControls);
	await page.setViewportSize({ width: 1440, height: 900 });
	await signUp(page, uniqueEmail("offline-reload"));
	await waitWorkspaceReady(page);
	await cachePublicShell(page);
	await page.getByTestId("sidebar-create").click();
	await page.getByTestId("sidebar-new-list").click();
	await page.getByTestId("new-list").fill("Offline reload list");
	await page.getByTestId("new-list-submit").click();
	await sidebarLists(page)
		.getByRole("button", { name: "Offline reload list", exact: true })
		.last()
		.click();
	const control = `Online reload control ${crypto.randomUUID()}`;
	await page.getByTestId("new-task").fill(control);
	await page.getByTestId("new-task-submit").click();
	await expect.poll(() => serverHasTask(control)).toBe(true);
	await expect(page.getByTestId("sync-indicator")).toHaveAttribute(
		"data-phase",
		"synced",
	);
	const queued = `Before offline reload ${crypto.randomUUID()}`;
	const restored = `After offline reload ${crypto.randomUUID()}`;
	try {
		await page.evaluate(holdIdlePersistence, queued);
		await context.setOffline(true);
		await page.getByTestId("new-task").fill(queued);
		await page.getByTestId("new-task-submit").click();
		await expect(
			page.getByTestId("list").getByText(queued, { exact: true }),
		).toBeVisible();
		await expect
			.poll(() =>
				page.evaluate(() => window.__zeroCloseControls.completedTransactions),
			)
			.toBeGreaterThan(0);
		await expect
			.poll(() => page.evaluate(() => window.__zeroCloseControls.idleRequests))
			.toBeGreaterThan(0);
		expect(await serverHasTask(queued)).toBe(false);
		await page.reload();
		await expect(page.getByTestId("offline-session")).toBeVisible();
		await sidebarLists(page)
			.getByRole("button", { name: "Offline reload list", exact: true })
			.last()
			.click();
		const list = page.getByTestId("list");
		await expect(list.getByText(control, { exact: true })).toBeVisible();
		await expect(list.getByText(queued, { exact: true })).toBeVisible();
		await expect(page.getByTestId("sync-indicator")).toHaveAttribute(
			"data-phase",
			"offline",
		);
		await page.getByTestId("new-task").fill(restored);
		await page.getByTestId("new-task-submit").click();
		await expect(list.getByText(restored, { exact: true })).toBeVisible();
		expect(await serverHasTask(restored)).toBe(false);
		await context.setOffline(false);
		await expect(page.getByTestId("offline-session")).toHaveCount(0);
		await expect
			.poll(() => serverHasTask(queued), { timeout: 30_000 })
			.toBe(true);
		await expect
			.poll(() => serverHasTask(restored), { timeout: 30_000 })
			.toBe(true);
		await expect(page.getByTestId("sync-indicator")).toHaveAttribute(
			"data-phase",
			"synced",
		);

		// An authoritative refusal must erase evidence even if cached rows remain.
		await page.route("**/api/auth/get-session**", (route) =>
			route.fulfill({
				status: 401,
				contentType: "application/json",
				body: JSON.stringify({
					code: "UNAUTHORIZED",
					message: "Session revoked",
				}),
			}),
		);
		await page.reload();
		await expect(page.getByTestId("signin")).toBeVisible();
		await expect
			.poll(() =>
				page.evaluate(() => localStorage.getItem("ditero.browser-session.v1")),
			)
			.toBeNull();
		await page.unroute("**/api/auth/get-session**");
		await context.setOffline(true);
		await page.reload();
		await expect(page.getByRole("alert")).toContainText(
			"Connect to the server",
		);
		await expect(page.getByTestId("offline-session")).toHaveCount(0);
		await expect(sidebarLists(page)).toHaveCount(0);
	} finally {
		await context.setOffline(false);
	}
});

test("sign-out fences a delayed session verification before the next offline reload", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await signUp(page, uniqueEmail("offline-sign-out"));
	await waitWorkspaceReady(page);
	await cachePublicShell(page);
	await goToSettings(page);
	let releaseSession!: () => void;
	const held = new Promise<void>((resolve) => {
		releaseSession = resolve;
	});
	let fetched!: () => void;
	const sessionFetched = new Promise<void>((resolve) => {
		fetched = resolve;
	});
	let intercepted = false;
	await page.route("**/api/auth/get-session**", async (route) => {
		if (intercepted) {
			await route.continue();
			return;
		}
		intercepted = true;
		const response = await route.fetch();
		expect((await response.json()).user.id).toBeTruthy();
		fetched();
		await held;
		await route.fulfill({ response });
	});
	let releaseSignOut!: () => void;
	const signOutHeld = new Promise<void>((resolve) => {
		releaseSignOut = resolve;
	});
	let signOutFetched!: () => void;
	const serverSignedOut = new Promise<void>((resolve) => {
		signOutFetched = resolve;
	});
	await page.route("**/api/auth/sign-out", async (route) => {
		const response = await route.fetch();
		signOutFetched();
		await signOutHeld;
		await route.fulfill({ response });
	});
	await page.evaluate(() => window.dispatchEvent(new Event("online")));
	await sessionFetched;
	await page.getByTestId("sign-out").click();
	await serverSignedOut;
	releaseSession();
	try {
		// The pre-sign-out response must be discarded before sign-out completes.
		await expect(page.getByTestId("signin")).toBeVisible();
	} finally {
		releaseSignOut();
	}
	await page.waitForResponse(
		(response) => new URL(response.url()).pathname === "/api/auth/sign-out",
	);
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ditero.browser-session.v1")),
		)
		.toBeNull();
	await page.unroute("**/api/auth/get-session**");
	try {
		await context.setOffline(true);
		await expectOfflineRefused(page);
	} finally {
		await context.setOffline(false);
	}
});

for (const status of [401, 403]) {
	test(`bootstrap ${status} after session verification disables offline restoration`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await signUp(page, uniqueEmail("offline-bootstrap"));
		await waitWorkspaceReady(page);
		await cachePublicShell(page);
		await expect
			.poll(() =>
				page.evaluate(() => localStorage.getItem("ditero.browser-session.v1")),
			)
			.not.toBeNull();
		await page.route("**/api/bootstrap", (route) =>
			route.fulfill({
				status,
				contentType: "application/json",
				body: JSON.stringify({ error: "Session revoked" }),
			}),
		);
		await page.reload();
		await expect
			.poll(() =>
				page.evaluate(() => localStorage.getItem("ditero.browser-session.v1")),
			)
			.toBeNull();
		await expect(page.getByTestId("offline-session")).toHaveCount(0);
		await page.unroute("**/api/bootstrap");
		try {
			await context.setOffline(true);
			await expectOfflineRefused(page);
		} finally {
			await context.setOffline(false);
		}
	});
}
