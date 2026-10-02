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
import { installPersistenceControls } from "./zero-persistence-controls.ts";

type BrowserBridge = typeof import("./zero-close-browser.ts");
async function bridge(page: Page) {
	return page.evaluate(async () => {
		const path = "/tests/e2e/zero-close-browser.ts";
		await import(path);
	});
}

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
	await expect(page.getByTestId("new-list")).toBeFocused();
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

test("desktop: rejected valid tokens back off and eventually deliver queued edits", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	let refusing = false;
	let recovering = false;
	const attempts: number[] = [];
	const tokenStatuses: number[] = [];
	page.on("response", (response) => {
		if (
			(refusing || recovering) &&
			new URL(response.url()).pathname === "/api/auth/token"
		)
			tokenStatuses.push(response.status());
	});
	await page.routeWebSocket(/\/sync\/v\d+\/connect/, (ws) => {
		if (refusing || recovering) attempts.push(performance.now());
		if (!refusing) {
			ws.connectToServer();
			return;
		}
		ws.send(
			JSON.stringify([
				"error",
				{
					kind: "Unauthorized",
					message: "token rejected",
					origin: "zeroCache",
				},
			]),
		);
	});
	await signUp(page, uniqueEmail("sync-backoff"));
	await openNewList(page, "Backoff");
	const indicator = page.getByTestId("sync-indicator");
	await expect(indicator).toHaveAttribute("data-phase", "synced", {
		timeout: 15000,
	});
	await context.setOffline(true);
	await expect(indicator).toHaveAttribute("data-phase", "offline", {
		timeout: 20000,
	});
	const title = `Queued through rejection ${uniqueEmail("edit")}`;
	await addTask(page, title);
	expect(await serverHasTask(title)).toBe(false);
	refusing = true;
	await context.setOffline(false);
	await expect(indicator).toHaveAttribute("data-phase", "auth-rejected", {
		timeout: 30000,
	});
	expect(attempts).toHaveLength(4);
	expect(tokenStatuses.length).toBeGreaterThanOrEqual(3);
	expect(tokenStatuses.every((status) => status === 200)).toBe(true);
	await indicator.click();
	const popover = page.getByTestId("sync-popover");
	await expect(popover).toContainText(
		"Your changes remain saved on this device",
	);
	await expect(popover.getByTestId("sync-sign-in")).toHaveCount(0);
	expect(await serverHasTask(title)).toBe(false);
	recovering = true;
	refusing = false;
	await expect(indicator).toHaveAttribute("data-phase", "synced", {
		timeout: 20000,
	});
	await expect.poll(() => serverHasTask(title), { timeout: 30000 }).toBe(true);
	expect(attempts[2] - attempts[1]).toBeGreaterThanOrEqual(950);
	expect(attempts[3] - attempts[2]).toBeGreaterThanOrEqual(1950);
	expect(attempts[4] - attempts[3]).toBeGreaterThanOrEqual(3950);
	expect(tokenStatuses.every((status) => status === 200)).toBe(true);
});

test("desktop: an expired sign-in keeps queued edits until the user signs in again", async ({
	page,
	context,
}) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	// Simulate the cache stream refusing an expired token. Live API session
	// checks do not immediately close an existing cache connection. The real
	// session is deleted before signing in again, so that part runs for real.
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
	await page.addInitScript(installPersistenceControls);
	await page.setViewportSize({ width: 1440, height: 900 });
	let refuseConnection = false;
	// Stand in for cache token expiry. Live API revocation is checked separately;
	// the cache can retain an existing connection until the token expires.
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
	await bridge(page);
	await context.setOffline(true);
	await expect(indicator).toHaveAttribute("data-phase", "offline", {
		timeout: 20000,
	});
	const title = `Queued across session expiry ${Date.now()}`;
	await page.evaluate(async (title) => {
		const path = "/tests/e2e/zero-close-browser.ts";
		const sdk = (await import(path)) as BrowserBridge;
		sdk.holdIdlePersistence(title);
	}, title);
	try {
		await addTask(page, title);
		await expect
			.poll(() => page.evaluate(() => window.__zeroCloseControls.idleRequests))
			.toBeGreaterThan(0);
		expect(await page.evaluate(() => window.__zeroCloseControls.puts)).toBe(0);
		await expireSession(email);
		const expiredToken = await page.request.get("/api/auth/token");
		expect(expiredToken.status()).toBe(401);
		refuseConnection = true;
		await context.setOffline(false);
		await expect(page.getByTestId("signin")).toBeVisible({ timeout: 30000 });
		expect(await serverHasTask(title)).toBe(false);
		await expect
			.poll(() =>
				page.evaluate(() => window.__zeroCloseControls.completedTransactions),
			)
			.toBeGreaterThan(0);
		refuseConnection = false;
		await page.getByTestId("email").fill(email);
		await page.getByTestId("password").fill("pw-123456");
		await page.getByTestId("signin").click();
		await waitWorkspaceReady(page);
		await expect
			.poll(() => serverHasTask(title), { timeout: 30000 })
			.toBe(true);
	} finally {
		await page.evaluate(() => window.__zeroCloseControls.restore());
	}
});

test("public Zero.close waits for accepted edits and durable persistence", async ({
	page,
	context,
}) => {
	test.setTimeout(120_000);
	await page.addInitScript(installPersistenceControls);
	const user = await signUp(page, uniqueEmail("sdk-close"));
	await openNewList(page, "SDK durability");
	await bridge(page);
	try {
		expect(
			await page.evaluate(async (userID) => {
				const path = "/tests/e2e/zero-close-browser.ts";
				const sdk = (await import(path)) as BrowserBridge;
				return sdk.openClient(userID, crypto.randomUUID(), "SDK durability");
			}, user),
		).toBe("connected");
		expect(
			await page.evaluate(async () => {
				const path = "/tests/e2e/zero-close-browser.ts";
				const sdk = (await import(path)) as BrowserBridge;
				return sdk.closeConnectedClient();
			}),
		).toMatchObject({
			before: "connected",
			after: "closed",
			beforeCloseReturned: true,
			reentrant: { refused: true },
		});
		await expect
			.poll(() =>
				page.evaluate(async () => {
					const path = "/tests/e2e/zero-close-browser.ts";
					return ((await import(path)) as BrowserBridge).socketSnapshot();
				}),
			)
			.toEqual([3]);
		await page.evaluate(async () => {
			const path = "/tests/e2e/zero-close-browser.ts";
			await ((await import(path)) as BrowserBridge).reopenClient();
		});
		await context.setOffline(true);
		const title = `SDK accepted ${crypto.randomUUID()}`;
		expect(
			await page.evaluate(async (title) => {
				const path = "/tests/e2e/zero-close-browser.ts";
				const sdk = (await import(path)) as BrowserBridge;
				sdk.holdIdlePersistence(title, "hold");
				return sdk.createTask(title, true);
			}, title),
		).toEqual({ type: "held" });
		expect(
			await page.evaluate(async () => {
				const path = "/tests/e2e/zero-close-browser.ts";
				return ((await import(path)) as BrowserBridge).beginClose();
			}),
		).toEqual({ samePromise: true });
		expect(
			await page.evaluate(async () => {
				const path = "/tests/e2e/zero-close-browser.ts";
				const sdk = (await import(path)) as BrowserBridge;
				const before = sdk.closeSnapshot();
				const late = await sdk.tryLateMutation();
				return { before, late, commit: await sdk.releaseAcceptedMutation() };
			}),
		).toMatchObject({
			before: { settled: false },
			late: { refused: true },
			commit: { type: "success" },
		});
		await expect
			.poll(() =>
				page.evaluate(() => window.__zeroCloseControls.completedTransactions),
			)
			.toBeGreaterThan(0);
		expect(
			await page.evaluate(async () => {
				const path = "/tests/e2e/zero-close-browser.ts";
				const sdk = (await import(path)) as BrowserBridge;
				const pending = sdk.closeSnapshot();
				sdk.releasePersistenceCompletion();
				return { pending, result: await sdk.closeResults() };
			}),
		).toMatchObject({
			pending: { settled: false },
			result: { statuses: ["fulfilled", "fulfilled"] },
		});
		expect(await serverHasTask(title)).toBe(false);
		await page.evaluate(async () => {
			const path = "/tests/e2e/zero-close-browser.ts";
			await ((await import(path)) as BrowserBridge).reopenClient();
		});
		await expect
			.poll(() =>
				page.evaluate(async () => {
					const path = "/tests/e2e/zero-close-browser.ts";
					return ((await import(path)) as BrowserBridge).cachedTasks();
				}),
			)
			.toContain(title);
		await context.setOffline(false);
		await expect
			.poll(() => serverHasTask(title), { timeout: 30000 })
			.toBe(true);
	} finally {
		await context.setOffline(false);
		await page.evaluate(async () => {
			const path = "/tests/e2e/zero-close-browser.ts";
			await ((await import(path)) as BrowserBridge).cleanupClient();
		});
	}
});

test("public Zero.close rejects persistence failure and recovers on explicit retry", async ({
	page,
	context,
}) => {
	test.setTimeout(120_000);
	await page.addInitScript(installPersistenceControls);
	const user = await signUp(page, uniqueEmail("sdk-close-failure"));
	await openNewList(page, "SDK retry");
	await bridge(page);
	try {
		await page.evaluate(async (userID) => {
			const path = "/tests/e2e/zero-close-browser.ts";
			await ((await import(path)) as BrowserBridge).openClient(
				userID,
				crypto.randomUUID(),
				"SDK retry",
			);
		}, user);
		await context.setOffline(true);
		const title = `SDK failed persist ${crypto.randomUUID()}`;
		expect(
			await page.evaluate(async (title) => {
				const path = "/tests/e2e/zero-close-browser.ts";
				const sdk = (await import(path)) as BrowserBridge;
				sdk.holdIdlePersistence(title, "fail");
				return sdk.createTask(title);
			}, title),
		).toMatchObject({ type: "success" });
		expect(
			await page.evaluate(async () => {
				const path = "/tests/e2e/zero-close-browser.ts";
				const sdk = (await import(path)) as BrowserBridge;
				return {
					close: sdk.beginClose(),
					result: await sdk.closeResults(),
					late: await sdk.tryLateMutation(),
				};
			}),
		).toMatchObject({
			close: { samePromise: true },
			result: {
				statuses: ["rejected", "rejected"],
				sameError: true,
				injectedError: true,
			},
			late: { refused: true },
		});
		expect(
			await page.evaluate(
				() => window.__zeroCloseControls.completedTransactions,
			),
		).toBe(0);
		await page.evaluate(async () => {
			const path = "/tests/e2e/zero-close-browser.ts";
			await ((await import(path)) as BrowserBridge).retryClose();
		});
		expect(
			await page.evaluate(
				() => window.__zeroCloseControls.completedTransactions,
			),
		).toBeGreaterThan(0);
		expect(await serverHasTask(title)).toBe(false);
		await page.evaluate(async () => {
			const path = "/tests/e2e/zero-close-browser.ts";
			await ((await import(path)) as BrowserBridge).reopenClient();
		});
		await expect
			.poll(() =>
				page.evaluate(async () => {
					const path = "/tests/e2e/zero-close-browser.ts";
					return ((await import(path)) as BrowserBridge).cachedTasks();
				}),
			)
			.toContain(title);
		await context.setOffline(false);
		await expect
			.poll(() => serverHasTask(title), { timeout: 30000 })
			.toBe(true);
	} finally {
		await context.setOffline(false);
		await page.evaluate(async () => {
			const path = "/tests/e2e/zero-close-browser.ts";
			await ((await import(path)) as BrowserBridge).cleanupClient();
		});
	}
});
