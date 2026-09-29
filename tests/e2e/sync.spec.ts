import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import {
	goToSettings,
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
	await expect(popover).toContainText("All your changes are saved");
	await expectNoSeriousA11y(page, "sync popover (synced)");
	await page.mouse.move(700, 450);
	await expect(popover).toHaveCount(0);

	await context.setOffline(true);
	await expect(indicator).toHaveAttribute("data-phase", "offline", {
		timeout: 20000,
	});
	const title = `Offline task ${Date.now()}`;
	await addTask(page, title);
	await expect(indicator).toContainText("1");
	await expect(indicator).toHaveAccessibleName(
		/Offline.*1 change waiting to sync/,
	);

	// A click pins the explanation; this is also the touch and keyboard path.
	await indicator.click();
	await expect(popover).toBeVisible();
	await expect(popover).toContainText("saved on this device");
	await expect(popover.getByTestId("sync-pending")).toHaveText(
		"1 change waiting to sync",
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
	await page.getByTestId("settings-back").click();
	await expect(fab).toBeVisible();
	await ctx.close();
});
