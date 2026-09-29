import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import {
	goToSettings,
	openMobileLists,
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

// Sync indicator (#354): a quiet synced state, an offline state that says
// edits are still kept, a pending count, and the queue landing on reconnect.

async function expectNoSeriousA11y(page: Page, surface: string) {
	const results = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
		.analyze();
	const serious = results.violations.filter(
		(v) => v.impact === "serious" || v.impact === "critical",
	);
	expect(serious, `serious/critical a11y violations on ${surface}`).toEqual([]);
}

async function openNewList(page: Page, name: string): Promise<void> {
	await waitWorkspaceReady(page);
	await page.getByTestId("sidebar-create").click();
	await page.getByTestId("sidebar-new-list").click();
	await page.getByTestId("new-list").fill(name);
	await page.getByTestId("new-list-submit").click();
	const nav = sidebarLists(page).getByRole("button", { name, exact: true });
	await expect(nav.first()).toBeVisible({ timeout: 15000 });
	await nav.last().click();
	await expect(page.getByTestId("list")).toBeVisible();
}

async function addTask(page: Page, title: string): Promise<void> {
	await page.getByTestId("new-task").fill(title);
	await page.getByTestId("new-task-submit").click();
	await expect(
		page.getByTestId("list").getByText(title, { exact: true }),
	).toBeVisible({ timeout: 15000 });
}

async function serverHasTask(title: string): Promise<boolean> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		const { rowCount } = await pool.query(
			"select 1 from task where title = $1",
			[title],
		);
		return (rowCount ?? 0) > 0;
	} finally {
		await pool.end();
	}
}

test("desktop: offline edits are kept, counted, and land on reconnect", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	// Zero checks its disconnect deadline against Date.now() on a 1s interval,
	// so a controlled clock can stand in for a long outage.
	await page.clock.install();
	await page.setViewportSize({ width: 1440, height: 900 });
	await signUp(page, uniqueEmail("sync"));
	await openNewList(page, "Sync");
	await addTask(page, "Online task");

	const indicator = page.getByTestId("sync-indicator");
	await expect(indicator).toHaveAttribute("data-phase", "synced", {
		timeout: 15000,
	});
	await expect(indicator).toHaveAccessibleName(/Synced/);

	// Hover previews the explanation without taking focus.
	await indicator.hover();
	const popover = page.locator('[data-testid="sync-popover"]');
	await expect(popover).toBeVisible();
	await expect(popover).toContainText("saved to the server right away");
	await expectNoSeriousA11y(page, "sync popover (synced)");
	await page.mouse.move(700, 450);
	await expect(popover).toHaveCount(0);

	await context.setOffline(true);
	await expect(indicator).toHaveAttribute("data-phase", "offline", {
		timeout: 20000,
	});
	// Well past Zero's one-minute default, after which it refuses every edit.
	await page.clock.fastForward("03:00");
	await expect(indicator).toHaveAttribute("data-phase", "offline");
	const title = `Offline task ${Date.now()}`;
	await addTask(page, title);
	await expect(page.getByText("this change wasn't saved")).toHaveCount(0);
	await expect(indicator).toHaveAttribute("data-phase", "offline");
	await expect(indicator).toContainText("1");
	await expect(indicator).toHaveAccessibleName(
		/Offline.*1 recent change not synced yet/,
	);

	// A click pins the explanation; this is also the touch and keyboard path.
	await indicator.click();
	await expect(popover).toBeVisible();
	await expect(popover).toContainText("saved on this device");
	await expect(popover.getByTestId("sync-pending")).toHaveText(
		"1 recent change not synced yet",
	);
	await expectNoSeriousA11y(page, "sync popover (offline)");
	await page.keyboard.press("Escape");
	await expect(popover).toHaveCount(0);
	expect(await serverHasTask(title)).toBe(false);

	await context.setOffline(false);
	await expect(indicator).toHaveAttribute("data-phase", "synced", {
		timeout: 30000,
	});
	await expect(indicator).not.toContainText("1");
	await expect.poll(() => serverHasTask(title)).toBe(true);
});

test("phones: the header carries the indicator and Settings has no add button", async ({
	browser,
}) => {
	const ctx = await browser.newContext({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});
	const page = await ctx.newPage();
	await signUp(page, uniqueEmail("sync-mobile"));
	await waitWorkspaceReady(page);

	const indicator = page.locator('header [data-testid="sync-indicator"]');
	await expect(indicator).toHaveAttribute("data-phase", "synced", {
		timeout: 15000,
	});
	const box = await indicator.boundingBox();
	expect(box?.width).toBeGreaterThanOrEqual(44);
	expect(box?.height).toBeGreaterThanOrEqual(44);
	await indicator.tap();
	await expect(page.locator('[data-testid="sync-popover"]')).toBeVisible();
	await expectNoSeriousA11y(page, "sync popover (phone)");
	await page.keyboard.press("Escape");

	const fab = page.locator('button[aria-label="Quick add"]');
	await expect(fab).toBeVisible();
	await goToSettings(page);
	await expect(fab).toHaveCount(0);
	await expect(
		page.locator(
			'[data-testid="settings-surface"] [data-testid="sync-indicator"]',
		),
	).toBeVisible();
	await page.getByTestId("settings-back").click();
	await expect(fab).toBeVisible();

	// Inside a list, where edits happen, the indicator is still there.
	await openMobileLists(page);
	await page.getByRole("button", { name: "New list" }).click();
	await page.getByTestId("new-list").fill("Errands");
	await page.getByTestId("new-list-submit").click();
	await page
		.getByTestId("list-index")
		.getByRole("button", { name: "Errands", exact: true })
		.click();
	const inList = page.locator(
		'[data-testid="list"] [data-testid="sync-indicator"]',
	);
	await expect(inList).toHaveAttribute("data-phase", "synced", {
		timeout: 15000,
	});
	await ctx.setOffline(true);
	await expect(inList).toHaveAttribute("data-phase", "offline", {
		timeout: 20000,
	});
	await ctx.setOffline(false);
	await ctx.close();
});

async function expireSession(email: string): Promise<void> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await pool.query(
			'delete from session where user_id = (select id from "user" where email = $1)',
			[email],
		);
	} finally {
		await pool.end();
	}
}

test("desktop: an expired sign-in keeps queued edits until the user signs in again", async ({
	page,
	context,
}) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	// zero-cache reports an expired sign-in only once the short-lived token
	// runs out, and the token endpoint refuses once the session is gone. The
	// routes answer the reconnect the way both then would; the real session is
	// deleted before signing in again, so that part runs for real.
	let refuseAuth = false;
	let refusedRefreshes = 0;
	await page.route("**/api/auth/token", (route) => {
		if (!refuseAuth) return route.continue();
		refusedRefreshes += 1;
		return route.fulfill({ status: 401, body: "{}" });
	});
	let unauthorizedConnections = 0;
	await page.routeWebSocket(/\/sync\/v\d+\/connect/, (ws) => {
		if (!refuseAuth) {
			ws.connectToServer();
			return;
		}
		unauthorizedConnections += 1;
		ws.send(
			JSON.stringify([
				"error",
				{ kind: "Unauthorized", message: "expired", origin: "zeroCache" },
			]),
		);
	});
	const email = uniqueEmail("sync-auth");
	await signUp(page, email);
	await openNewList(page, "Away");
	const indicator = page.getByTestId("sync-indicator");
	await expect(indicator).toHaveAttribute("data-phase", "synced", {
		timeout: 15000,
	});

	await context.setOffline(true);
	await expect(indicator).toHaveAttribute("data-phase", "offline", {
		timeout: 20000,
	});
	const title = `Queued before sign-in ${Date.now()}`;
	await addTask(page, title);
	refuseAuth = true;
	const refusedRefresh = page.waitForResponse("**/api/auth/token");
	await context.setOffline(false);
	expect((await refusedRefresh).status()).toBe(401);
	expect(unauthorizedConnections).toBeGreaterThan(0);
	expect(refusedRefreshes).toBeGreaterThan(0);

	await expect(indicator).toHaveAttribute("data-phase", "reauth", {
		timeout: 30000,
	});
	await indicator.click();
	const popover = page.locator('[data-testid="sync-popover"]');
	await expect(popover).toContainText("sync after you sign in again");
	await expectNoSeriousA11y(page, "sync popover (sign in again)");
	expect(await serverHasTask(title)).toBe(false);

	refuseAuth = false;
	await expireSession(email);
	const expiredToken = await page.request.get("/api/auth/token");
	expect(expiredToken.status()).toBe(401);
	await popover.getByTestId("sync-sign-in").click();
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill("pw-123456");
	await page.getByTestId("signin").click();
	await waitWorkspaceReady(page);
	await expect.poll(() => serverHasTask(title), { timeout: 30000 }).toBe(true);
});

test("desktop: a real expired session returns to login and preserves queued edits", async ({
	page,
	context,
}) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	let refuseConnection = false;
	// Stand in for JWT expiry too: deleting a session does not revoke its
	// already-issued token, which would otherwise remain valid on reconnect.
	await page.routeWebSocket(/\/sync\/v\d+\/connect/, (ws) => {
		if (!refuseConnection) {
			ws.connectToServer();
			return;
		}
		ws.send(
			JSON.stringify([
				"error",
				{ kind: "Unauthorized", message: "expired", origin: "zeroCache" },
			]),
		);
	});
	const email = uniqueEmail("sync-session");
	await signUp(page, email);
	await openNewList(page, "Expired session");
	const indicator = page.getByTestId("sync-indicator");
	await expect(indicator).toHaveAttribute("data-phase", "synced", {
		timeout: 15000,
	});
	await context.setOffline(true);
	await expect(indicator).toHaveAttribute("data-phase", "offline", {
		timeout: 20000,
	});
	const title = `Queued across session expiry ${Date.now()}`;
	await addTask(page, title);
	await expireSession(email);
	const expiredToken = await page.request.get("/api/auth/token");
	expect(expiredToken.status()).toBe(401);
	refuseConnection = true;
	await context.setOffline(false);
	await expect(page.getByTestId("signin")).toBeVisible({ timeout: 30000 });
	expect(await serverHasTask(title)).toBe(false);
	refuseConnection = false;
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill("pw-123456");
	await page.getByTestId("signin").click();
	await waitWorkspaceReady(page);
	await expect.poll(() => serverHasTask(title), { timeout: 30000 }).toBe(true);
});
