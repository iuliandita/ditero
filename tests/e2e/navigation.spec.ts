import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import {
	openMobileLists,
	openWorkspaceSwitcher,
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

// #351: the sidebar and the mobile shell lead with navigation, the workspace
// switcher owns workspace admin, item types are told apart by glyph, page
// headers share their content's box, and quick add fits the device.

const SHARED_WORKSPACE_ID = "w_shared_e2e";

async function joinShared(email: string): Promise<void> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		const { rows } = await pool.query<{ id: string }>(
			`select id from "user" where email = $1`,
			[email],
		);
		await pool.query(
			`insert into membership (id, user_id, workspace_id, role)
			 values ($1, $2, $3, 'owner')`,
			[crypto.randomUUID(), rows[0].id, SHARED_WORKSPACE_ID],
		);
	} finally {
		await pool.end();
	}
}

async function createList(page: Page, name: string): Promise<void> {
	await page.getByTestId("create-list-open").click();
	await page.getByTestId("new-list").fill(name);
	await page.getByTestId("new-list-submit").click();
	await expect(
		sidebarLists(page).getByRole("button", { name, exact: true }),
	).toBeVisible({ timeout: 15000 });
}

async function createFolder(page: Page, name: string): Promise<void> {
	await page.getByTestId("sidebar-create").click();
	await page.getByTestId("new-folder").click();
	await page.getByTestId("folder-name-input").fill(name);
	await page.getByTestId("folder-name-save").click();
	await expect(page.getByTestId("folder-name-input")).toBeHidden();
}

async function createDashboard(page: Page, name: string): Promise<void> {
	await page.getByTestId("sidebar-create").click();
	await page.getByTestId("new-dashboard").click();
	await page.getByTestId("dashboard-name").fill(name);
	await page.getByTestId("dashboard-save").click();
	await expect(page.getByTestId("dashboard-name")).toBeHidden({
		timeout: 15000,
	});
}

async function iconClass(row: Locator): Promise<string> {
	const cls = await row.locator("svg").first().getAttribute("class");
	if (!cls) throw new Error("row has no icon");
	return cls.split(/\s+/).find((c) => c.startsWith("lucide-")) ?? cls;
}

async function box(locator: Locator) {
	const b = await locator.boundingBox();
	if (!b) throw new Error("element has no box");
	return { left: b.x, right: b.x + b.width, width: b.width };
}

test("sidebar leads with Today, nests lists under folders, and has no bare headings", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await signUp(page, uniqueEmail("nav-order"));
	await waitWorkspaceReady(page);
	await createFolder(page, "Trips");
	await createList(page, "Errands");
	await createDashboard(page, "Weekly");

	const nav = sidebarLists(page);
	// Today is the very first destination, before any section.
	const rows = nav.locator("button[data-nav-kind], button[data-list-id]");
	await expect(rows.first()).toHaveText("Today");
	await expect(rows.nth(1)).toHaveText("All my tasks");
	await expect(rows.nth(2)).toHaveText("Assigned to me");

	// Section order: built-ins, then lists, then dashboards.
	const order = await nav
		.locator("[data-nav-group]")
		.evaluateAll((els) => els.map((el) => el.getAttribute("data-nav-group")));
	expect(order).toEqual(["primary", "lists", "dashboards"]);

	// The empty folder is a row with a next step under it, not a bare heading
	// stacked on a generic one.
	const folder = nav.locator("li[data-folder-id]");
	await expect(folder).toHaveCount(1);
	await expect(folder).toContainText("Trips");
	await expect(folder.getByTestId("folder-empty")).toBeVisible();
	const lists = nav.getByRole("region", { name: "Lists" });
	await expect(lists.getByText("Lists", { exact: true })).toHaveCount(1);
	// Every titled section has at least one row under it.
	for (const section of await nav.locator("section[data-nav-group]").all())
		expect(
			await section
				.locator(
					"button[data-nav-kind], button[data-list-id], [data-folder-id]",
				)
				.count(),
		).toBeGreaterThan(0);

	// Workspace admin is not in the rail's top anymore.
	await expect(page.getByTestId("open-shared")).toHaveCount(0);
	await expect(page.getByTestId("open-members")).toHaveCount(0);

	// Dashboards fold away and stay folded across a reload.
	const dashboards = nav.getByRole("region", { name: "Dashboards" });
	const toggle = dashboards.getByRole("button", { name: "Dashboards" });
	await expect(
		dashboards.getByRole("button", { name: "Weekly", exact: true }),
	).toBeVisible();
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(
		dashboards.getByRole("button", { name: "Weekly", exact: true }),
	).toHaveCount(0);
	await page.reload();
	await waitWorkspaceReady(page);
	await expect(
		sidebarLists(page).getByRole("button", { name: "Dashboards" }),
	).toHaveAttribute("aria-expanded", "false");
	await sidebarLists(page).getByRole("button", { name: "Dashboards" }).click();
	await expect(
		sidebarLists(page).getByRole("button", { name: "Weekly", exact: true }),
	).toBeVisible();
});

test("desktop Today shows no list index; New list opens the form on request", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await signUp(page, uniqueEmail("nav-landing"));
	await waitWorkspaceReady(page);
	await createList(page, "Errands");
	await sidebarLists(page)
		.getByRole("button", { name: "Today", exact: true })
		.click();
	const main = page.locator("main");
	await expect(main.getByTestId("view-surface")).toBeVisible();
	await expect(main.getByTestId("new-list")).toHaveCount(0);
	await expect(main.getByRole("heading", { level: 2 })).toHaveCount(0);
	await expect(main.getByText("'s space")).toHaveCount(0);

	await page.getByTestId("create-list-open").click();
	await expect(main.getByTestId("new-list")).toBeFocused();
	await main.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(main.getByTestId("new-list")).toHaveCount(0);
});

test("each item type has its own glyph, named by its section", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await signUp(page, uniqueEmail("nav-icons"));
	await waitWorkspaceReady(page);
	await createFolder(page, "Home");
	await createList(page, "Errands");
	await createDashboard(page, "Weekly");
	await page.getByTestId("sidebar-create").click();
	await page.getByTestId("new-view").click();
	await page.getByTestId("view-name").fill("Everything");
	await page.getByTestId("view-save").click();
	await expect(page.getByTestId("view-surface")).toBeVisible({
		timeout: 15000,
	});
	const nav = sidebarLists(page);
	const views = nav.getByRole("region", { name: "Views" });
	if (!(await views.count())) {
		await page.getByTestId("view-actions").click();
		await page.getByTestId("view-pin").click();
	}

	const today = nav.getByRole("button", { name: "Today", exact: true });
	const allMine = nav.getByRole("button", {
		name: "All my tasks",
		exact: true,
	});
	const assigned = nav.getByRole("button", {
		name: "Assigned to me",
		exact: true,
	});
	const saved = views.getByRole("button", { name: "Everything", exact: true });
	const dashboard = nav
		.getByRole("region", { name: "Dashboards" })
		.getByRole("button", { name: "Weekly", exact: true });
	const folder = nav.locator("li[data-folder-id]").first();
	const list = nav
		.getByRole("region", { name: "Lists" })
		.getByRole("button", { name: "Errands", exact: true });

	const glyphs = [
		await iconClass(today),
		await iconClass(allMine),
		await iconClass(assigned),
		await iconClass(saved),
		await iconClass(dashboard),
		await iconClass(folder),
		await iconClass(list),
	];
	expect(glyphs[0]).toBe("lucide-sun");
	expect(glyphs[4]).toBe("lucide-layout-dashboard");
	expect(glyphs[5]).toBe("lucide-folder");
	expect(new Set(glyphs).size).toBe(glyphs.length);
});

test("workspace switcher switches and owns member management", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const email = uniqueEmail("nav-switch");
	await signUp(page, email);
	await waitWorkspaceReady(page);

	const trigger = page.getByTestId("workspace-switcher");
	await expect(trigger).toContainText("'s space");
	await openWorkspaceSwitcher(page);
	// Personal only: no members to manage, and it says why.
	await expect(page.getByTestId("workspace-option")).toHaveCount(1);
	await expect(page.getByTestId("workspace-private-note")).toBeVisible();
	await expect(page.getByTestId("manage-members")).toHaveCount(0);
	await page.keyboard.press("Escape");

	// Once a shared workspace is listed, the note would be false: it goes.
	await joinShared(email);
	await openWorkspaceSwitcher(page);
	await expect(page.getByTestId("workspace-option")).toHaveCount(2, {
		timeout: 15000,
	});
	await expect(page.getByTestId("workspace-private-note")).toHaveCount(0);
	await expect(page.getByTestId("manage-members")).toHaveCount(0);
	await expectNoSeriousA11y(page, "workspace switcher");

	await page
		.locator('[data-testid="workspace-option"][data-workspace-kind="shared"]')
		.click();
	await expect(trigger).toHaveText(/Household/);
	await expect(
		sidebarLists(page).getByRole("button", {
			name: "Shared list",
			exact: true,
		}),
	).toBeVisible({ timeout: 15000 });

	await openWorkspaceSwitcher(page);
	await expect(page.getByTestId("workspace-private-note")).toHaveCount(0);
	await page.getByTestId("manage-members").click();
	await expect(page.getByTestId("members-panel")).toBeVisible();
	await expect(page.getByTestId("members-panel")).toContainText("(you)");
});

test("phones: Today is a tab, settings leaves the bar, and each tab keeps to its job", async ({
	browser,
}) => {
	const ctx = await browser.newContext({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});
	const page = await ctx.newPage();
	const email = uniqueEmail("nav-mobile");
	await signUp(page, email);
	await waitWorkspaceReady(page);

	const bar = page.locator('nav[aria-label="Primary"]');
	await expect(bar.locator("button")).toHaveCount(3);
	await expect(page.getByTestId("nav-tab-settings")).toHaveCount(0);
	await expect(page.getByTestId("nav-tab-today")).toHaveAttribute(
		"aria-current",
		"page",
	);
	for (const tab of ["nav-tab-today", "nav-tab-lists", "nav-tab-search"]) {
		const b = await box(page.getByTestId(tab));
		expect(b.width).toBeGreaterThanOrEqual(44);
	}

	// Today: today's tasks only, no index, no create-view/dashboard controls.
	await expect(page.getByTestId("view-surface")).toBeVisible();
	await expect(page.getByTestId("list-index")).toHaveCount(0);
	await expect(page.getByTestId("new-view")).toHaveCount(0);
	await expect(page.getByTestId("new-dashboard")).toHaveCount(0);

	// Lists: the index grouped like the sidebar, and no Today view.
	await openMobileLists(page);
	await expect(page.getByTestId("nav-tab-lists")).toHaveAttribute(
		"aria-current",
		"page",
	);
	await expect(page.getByTestId("view-surface")).toHaveCount(0);
	await expect(page.getByTestId("new-view")).toBeVisible();
	await expect(page.getByTestId("new-dashboard")).toBeVisible();
	await expectNoSeriousA11y(page, "mobile lists tab");

	// Settings is one switcher away; focus lands on its way back, and back
	// returns to the tab that opened it.
	await openWorkspaceSwitcher(page);
	await page.getByTestId("switcher-settings").click();
	await expect(page.getByTestId("settings-surface")).toBeVisible();
	await expect(page.getByTestId("settings-back")).toBeFocused();
	await page.getByTestId("settings-back").click();
	await expect(page.getByTestId("settings-surface")).toHaveCount(0);
	await expect(page.getByTestId("nav-tab-lists")).toHaveAttribute(
		"aria-current",
		"page",
	);

	// Grips stay out of the way of taps until Reorder is on (#369).
	for (const name of ["Errands", "Garden"]) {
		await page.getByRole("button", { name: "New list" }).click();
		await page.getByTestId("new-list").fill(name);
		await page.getByTestId("new-list-submit").click();
		await expect(
			page.getByTestId("list-index").getByRole("button", { name, exact: true }),
		).toBeVisible({ timeout: 15000 });
		await openMobileLists(page);
	}
	const grip = page.getByTestId("list-drag").first();
	expect((await box(grip)).width).toBeLessThan(2);
	await page.getByTestId("list-reorder-mode").click();
	await expect(page.getByTestId("list-reorder-bar")).toBeVisible();
	expect((await box(grip)).width).toBeGreaterThanOrEqual(44);
	await page
		.getByTestId("list-reorder-bar")
		.getByRole("button", { name: "Done" })
		.click();
	expect((await box(grip)).width).toBeLessThan(2);

	// A home view other than Today still lands phones on the Today tab, so the
	// tab bar names what is on screen.
	await page.getByRole("button", { name: "All my tasks", exact: true }).click();
	await expect(page.getByTestId("nav-tab-lists")).toHaveAttribute(
		"aria-current",
		"page",
	);
	await page.getByTestId("view-actions").click();
	await page.getByTestId("view-set-home").click();
	await page.reload();
	await waitWorkspaceReady(page);
	await expect(page.getByTestId("nav-tab-today")).toHaveAttribute(
		"aria-current",
		"page",
	);
	await expect(
		page.getByTestId("view-surface").getByRole("heading", { level: 1 }),
	).toHaveText("Today");

	// Manage members from the sheet hands focus into the members panel.
	await joinShared(email);
	await openWorkspaceSwitcher(page);
	await page
		.locator('[data-testid="workspace-option"][data-workspace-kind="shared"]')
		.click();
	await expect(page.getByTestId("workspace-switcher")).toContainText(
		"Household",
	);
	await openWorkspaceSwitcher(page);
	await page.getByTestId("manage-members").click();
	const panel = page.getByTestId("members-panel");
	await expect(panel).toBeVisible();
	await expect
		.poll(() => panel.evaluate((el) => el.contains(document.activeElement)))
		.toBe(true);
	await page.keyboard.press("Escape");
	await expect(panel).toHaveCount(0);

	// Quick add stays a bottom sheet on a phone.
	await page.getByRole("button", { name: "Quick add", exact: true }).click();
	const sheet = page.getByTestId("quickadd-sheet");
	await expect(sheet).toBeVisible();
	await expect(page.getByTestId("quickadd-dialog")).toHaveCount(0);
	await expect
		.poll(async () => {
			const b = await sheet.boundingBox();
			return b ? [Math.round(b.width), Math.round(b.y + b.height)] : null;
		})
		.toEqual([390, 844]);
	await ctx.close();
});

for (const width of [1440, 1280]) {
	test(`page headers share their content's right edge at ${width}px, with and without the task panel`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 900 });
		await signUp(page, uniqueEmail(`nav-edge-${width}`));
		await waitWorkspaceReady(page);
		await createList(page, "Errands");
		await sidebarLists(page)
			.getByRole("button", { name: "Errands", exact: true })
			.click();
		await page.getByTestId("new-task").fill("Buy stamps");
		await page.getByTestId("new-task-submit").click();
		await expect(
			page.getByTestId("list").getByText("Buy stamps", { exact: true }),
		).toBeVisible({ timeout: 15000 });

		const listEdges = async () => {
			const header = await box(
				page.locator("[data-testid=list] h1").locator(".."),
			);
			const addRow = await box(page.getByTestId("new-task-submit"));
			return Math.abs(header.right - addRow.right);
		};
		expect(await listEdges()).toBeLessThanOrEqual(1);

		// The views surface, where the menu used to sit at the pane's far edge.
		await sidebarLists(page)
			.getByRole("button", { name: "All my tasks", exact: true })
			.click();
		const surface = page.getByTestId("view-surface");
		await expect(
			surface.getByText("Buy stamps", { exact: true }),
		).toBeVisible();
		const viewEdges = async () => {
			const menu = await box(page.getByTestId("view-actions"));
			const row = await box(
				surface.locator("[data-kbd-row]").filter({ hasText: "Buy stamps" }),
			);
			const frame = await box(page.locator("[data-page-frame]"));
			return {
				gap: Math.abs(menu.right - row.right),
				inFrame: menu.right <= frame.right + 1,
				frameWidth: frame.width,
			};
		};
		const open = await viewEdges();
		expect(open.gap).toBeLessThanOrEqual(1);
		expect(open.inFrame).toBe(true);

		// With the docked task detail the pane narrows; the edges still agree.
		await surface
			.locator("[data-kbd-row]")
			.filter({ hasText: "Buy stamps" })
			.getByRole("button", { name: "Open details" })
			.click();
		await expect(page.locator("[data-task-panel]")).toBeVisible();
		const docked = await viewEdges();
		expect(docked.gap).toBeLessThanOrEqual(1);
		expect(docked.inFrame).toBe(true);
		expect(docked.frameWidth).toBeLessThanOrEqual(open.frameWidth);
		await page.getByTestId("task-detail-close").click();
		await expect(page.locator("[data-task-panel]")).toHaveCount(0);

		// Settings: the heading row and the panels share one box.
		await page.getByTestId("nav-settings").click();
		const settings = page.getByTestId("settings-surface");
		const heading = await box(
			settings.getByRole("heading", { level: 1 }).locator(".."),
		);
		const panel = await box(settings.locator("section").first());
		expect(Math.abs(heading.right - panel.right)).toBeLessThanOrEqual(1);
	});
}

test("desktop quick add is a centered dialog, not a full-width sheet", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await signUp(page, uniqueEmail("nav-quickadd"));
	await waitWorkspaceReady(page);
	await createList(page, "Errands");
	await sidebarLists(page)
		.getByRole("button", { name: "Errands", exact: true })
		.click();
	await expect(page.getByTestId("list")).toBeVisible();
	await page.locator("main").click({ position: { x: 10, y: 600 } });
	await page.keyboard.press("c");

	const dialog = page.getByTestId("quickadd-dialog");
	await expect(dialog).toBeVisible();
	await expect(page.getByTestId("quickadd-sheet")).toHaveCount(0);
	await page.getByTestId("quickadd-input").fill("Call mum tomorrow p2");
	await expect(page.getByTestId("chip-priority")).toBeVisible();
	await expect(dialog).toContainText("Adding to Errands");
	await expect
		.poll(async () => {
			const b = await dialog.boundingBox();
			if (!b) return null;
			const leftGap = b.x;
			const rightGap = 1440 - (b.x + b.width);
			return {
				width: Math.round(b.width),
				centered: Math.abs(leftGap - rightGap) <= 2,
			};
		})
		.toEqual({ width: 512, centered: true });
	await expectNoSeriousA11y(page, "quick add dialog");
});

async function expectNoSeriousA11y(page: Page, surface: string) {
	const results = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
		.analyze();
	const serious = results.violations.filter(
		(v) => v.impact === "serious" || v.impact === "critical",
	);
	expect(serious, `serious/critical a11y violations on ${surface}`).toEqual([]);
}
