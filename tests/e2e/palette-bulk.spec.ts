import AxeBuilder from "@axe-core/playwright";
import {
	type Browser,
	expect,
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import { Pool } from "pg";
import {
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

// A useful command palette on open and bulk editing in lists (#360).

test.describe.configure({ timeout: 90_000 });

async function expectNoSeriousA11y(page: Page, surface: string) {
	await page.addStyleTag({
		content:
			"*,*::before,*::after{animation:none!important;transition:none!important}",
	});
	const { violations } = await new AxeBuilder({ page }).analyze();
	const serious = violations.filter(
		(v) => v.impact === "serious" || v.impact === "critical",
	);
	expect(
		serious.map((v) => v.id),
		`serious/critical a11y violations on ${surface}`,
	).toEqual([]);
}

async function newList(page: Page, name: string): Promise<void> {
	await page.getByTestId("sidebar-create").click();
	await page.getByTestId("sidebar-new-list").click();
	await page.getByTestId("new-list").fill(name);
	await page.getByTestId("new-list-submit").click();
	await expect(
		sidebarLists(page).getByRole("button", { name, exact: true }).first(),
	).toBeVisible({ timeout: 15000 });
}

async function openList(page: Page, name: string): Promise<void> {
	await sidebarLists(page)
		.getByRole("button", { name, exact: true })
		.last()
		.click();
	await expect(page.getByTestId("list")).toBeVisible();
	await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

async function addTasks(page: Page, titles: string[]): Promise<void> {
	for (const title of titles) {
		await page.getByTestId("new-task").fill(title);
		await page.getByTestId("new-task-submit").click();
		await expect(
			page.getByTestId("list").getByRole("checkbox", { name: title }),
		).toBeVisible({ timeout: 15000 });
	}
}

// Found by its title text, not its done checkbox: selection mode swaps that
// checkbox out for the select control.
function row(page: Page, title: string, scope = "list"): Locator {
	return page
		.getByTestId(scope)
		.locator("[data-kbd-row]")
		.filter({ has: page.getByText(title, { exact: true }) });
}

function openButton(page: Page, title: string): Locator {
	return row(page, title).getByRole("button", { name: "Open details" });
}

async function setupList(
	page: Page,
	prefix: string,
	titles: string[],
): Promise<void> {
	await signUp(page, uniqueEmail(prefix));
	await waitWorkspaceReady(page);
	await newList(page, "Home");
	await newList(page, "Errands");
	await openList(page, "Errands");
	await addTasks(page, titles);
}

const palette = (page: Page) =>
	page.getByRole("combobox", { name: "Command palette search" });

test("palette opens on Recent, Lists, Views and commands, and search opens a task", async ({
	page,
}) => {
	await setupList(page, "pal", ["Buy stamps", "Call the plumber"]);
	// Opening a task records it as recent.
	await openButton(page, "Call the plumber").click();
	await expect(page.getByTestId("task-detail")).toBeVisible();
	await page.getByTestId("task-detail-close").click();
	await expect(page.getByTestId("task-detail")).toHaveCount(0);

	await page.keyboard.press("ControlOrMeta+k");
	await expect(palette(page)).toBeVisible();
	const recent = page.getByTestId("palette-group-recent");
	await expect(recent).toBeVisible();
	await expect(recent.getByRole("option").first()).toContainText(
		"Call the plumber",
	);
	await expect(
		recent.getByRole("option", { name: "Errands", exact: true }),
	).toHaveCount(1);
	await expect(
		page.getByTestId("palette-group-lists").getByRole("option", {
			name: "Home",
		}),
	).toBeVisible();
	await expect(
		page.getByTestId("palette-group-views").getByRole("option", {
			name: "Today",
		}),
	).toBeVisible();
	await expect(
		page.getByTestId("palette-group-commands").getByRole("option", {
			name: /New task/,
		}),
	).toBeVisible();
	await expectNoSeriousA11y(page, "palette empty state");

	// Typing searches tasks, grouped under their own header; Enter opens the
	// task itself, not just its list.
	await palette(page).fill("stamps");
	const tasks = page.getByTestId("palette-group-tasks");
	await expect(tasks.getByRole("option", { name: /Buy stamps/ })).toBeVisible();
	await expect(page.getByTestId("palette-group-recent")).toHaveCount(0);
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("command-palette")).toHaveCount(0);
	await expect(page.getByTestId("task-detail-title")).toHaveValue("Buy stamps");

	// Views and lists are searchable too.
	await page.getByTestId("task-detail-close").click();
	await page.keyboard.press("ControlOrMeta+k");
	await palette(page).fill("tod");
	await expect(
		page.getByTestId("palette-group-views").getByRole("option", {
			name: "Today",
		}),
	).toBeVisible();
	await palette(page).fill("hom");
	await page.keyboard.press("Enter");
	await expect(
		page.getByRole("heading", { name: "Home", level: 1 }),
	).toBeVisible();
});

test("keyboard multi-select, bulk complete, and one Undo restores all", async ({
	page,
}) => {
	const titles = ["Row one", "Row two", "Row three", "Row four"];
	await setupList(page, "bulk-kbd", titles);

	await openButton(page, "Row one").focus();
	await page.keyboard.press("s");
	await page.keyboard.press("Shift+ArrowDown");
	await page.keyboard.press("Shift+ArrowDown");
	const bar = page.getByTestId("selection-bar");
	await expect(bar).toBeVisible();
	await expect(page.getByTestId("selection-count")).toHaveText(
		"3 tasks selected",
	);
	await expect(page.getByTestId("selection-live")).toHaveText(
		"3 tasks selected",
	);
	for (const t of titles.slice(0, 3))
		await expect(row(page, t).getByTestId("task-select")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	await expect(
		row(page, "Row four").getByTestId("task-select"),
	).toHaveAttribute("aria-pressed", "false");
	// Extending back toward the anchor shrinks the range.
	await page.keyboard.press("Shift+ArrowUp");
	await expect(page.getByTestId("selection-count")).toHaveText(
		"2 tasks selected",
	);
	await page.keyboard.press("Shift+ArrowDown");
	// Selection mode: the select control leads every row and the done checkbox
	// steps aside, so `x` and a stray click cannot complete anything.
	await expect(page.getByTestId("list").getByRole("checkbox")).toHaveCount(0);
	await expect(
		row(page, "Row four").locator(
			'[data-testid="task-select"][data-placement="lead"]',
		),
	).toBeVisible();
	await page.keyboard.press("x");
	await openButton(page, "Row four").click();
	await expect(page.getByTestId("selection-count")).toHaveText(
		"4 tasks selected",
	);
	await expect(page.getByTestId("task-detail")).toHaveCount(0);
	await openButton(page, "Row four").click();
	await expect(page.getByTestId("selection-count")).toHaveText(
		"3 tasks selected",
	);
	await expectNoSeriousA11y(page, "list with selection bar");

	await bar.getByTestId("selection-complete").click();
	await expect(bar).toHaveCount(0);
	const snackbar = page.getByTestId("snackbar");
	await expect(snackbar).toContainText("Completed 3 tasks.");
	const section = page.getByTestId("list").getByTestId("completed-section");
	await expect(section).toHaveText(/3 items completed/, { timeout: 5000 });
	await expect(
		page.getByTestId("list").getByRole("checkbox", { name: "Row four" }),
	).not.toBeChecked();

	await snackbar.getByTestId("snackbar-action").click();
	await expect(section).toHaveCount(0);
	for (const t of titles)
		await expect(
			page.getByTestId("list").getByRole("checkbox", { name: t, exact: true }),
		).not.toBeChecked();
});

test("Escape and select-all, then bulk move with Undo", async ({ page }) => {
	const titles = ["Move A", "Move B", "Stay C"];
	await setupList(page, "bulk-move", titles);

	// Ctrl/Cmd+A selects every row; Escape clears it.
	await openButton(page, "Move A").focus();
	await page.keyboard.press("ControlOrMeta+a");
	await expect(page.getByTestId("selection-count")).toHaveText(
		"3 tasks selected",
	);
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("selection-bar")).toHaveCount(0);

	// Cmd/Ctrl-click picks rows without opening them.
	await openButton(page, "Move A").click({ modifiers: ["ControlOrMeta"] });
	await openButton(page, "Move B").click({ modifiers: ["ControlOrMeta"] });
	await expect(page.getByTestId("task-detail")).toHaveCount(0);
	await expect(page.getByTestId("selection-count")).toHaveText(
		"2 tasks selected",
	);

	await page.getByTestId("selection-move").click();
	await page
		.getByTestId("selection-move-target")
		.filter({ hasText: "Home" })
		.click();
	const snackbar = page.getByTestId("snackbar");
	await expect(snackbar).toContainText("Moved 2 tasks to Home");
	// Moved in the order they were on screen.
	await openList(page, "Home");
	const homeTitles = await page
		.getByTestId("list")
		.getByRole("checkbox")
		.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
	expect(homeTitles).toEqual(["Move A", "Move B"]);
	await openList(page, "Errands");
	const list = page.getByTestId("list");
	await expect(list.getByRole("checkbox", { name: "Move A" })).toHaveCount(0);
	await expect(list.getByRole("checkbox", { name: "Move B" })).toHaveCount(0);
	await expect(list.getByRole("checkbox", { name: "Stay C" })).toBeVisible();

	await snackbar.getByTestId("snackbar-action").click();
	await expect(list.getByRole("checkbox", { name: "Move A" })).toBeVisible();
	await expect(list.getByRole("checkbox", { name: "Move B" })).toBeVisible();
	await openList(page, "Home");
	await expect(
		page.getByTestId("list").getByRole("checkbox", { name: "Move A" }),
	).toHaveCount(0);
});

test("bulk due date and bulk delete with a counted confirm", async ({
	page,
}) => {
	const titles = ["Due one", "Due two", "Untouched"];
	await setupList(page, "bulk-due", titles);

	await openButton(page, "Due one").click({ modifiers: ["ControlOrMeta"] });
	await openButton(page, "Due two").click({ modifiers: ["Shift"] });
	await expect(page.getByTestId("selection-count")).toHaveText(
		"2 tasks selected",
	);
	await page.getByTestId("selection-due").click();
	await page.getByTestId("due-pick-tomorrow").click();
	await expect(page.getByTestId("due-picker-content")).toHaveCount(0);
	await expect(row(page, "Due one")).toContainText("Tomorrow");
	await expect(row(page, "Due two")).toContainText("Tomorrow");
	await expect(row(page, "Untouched")).not.toContainText("Tomorrow");
	// Due and priority keep the selection for a follow-up edit.
	await expect(page.getByTestId("selection-count")).toHaveText(
		"2 tasks selected",
	);

	await page.getByTestId("selection-delete").click();
	const confirm = page.getByRole("alertdialog");
	await expect(confirm).toContainText("Delete 2 tasks?");
	await expect(confirm).toContainText("This deletes 2 tasks");
	await confirm.getByRole("button", { name: "Delete" }).click();
	const list = page.getByTestId("list");
	await expect(list.getByRole("checkbox", { name: "Due one" })).toHaveCount(0);
	await expect(list.getByRole("checkbox", { name: "Due two" })).toHaveCount(0);
	await expect(list.getByRole("checkbox", { name: "Untouched" })).toBeVisible();
	await expect(page.getByTestId("selection-bar")).toHaveCount(0);
});

test("selection keys sit in the cheat sheet beside the existing single keys", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("bulk-keys"));
	await waitWorkspaceReady(page);
	await page.locator("body").click({ position: { x: 900, y: 600 } });
	await page.keyboard.press("?");
	const sheet = page.getByRole("dialog");
	await expect(sheet.getByText("Selection", { exact: true })).toBeVisible();
	const toggle = sheet.locator("li", { hasText: "Select or deselect task" });
	await expect(toggle.locator("kbd")).toHaveText("s");
	// The existing completion key is untouched.
	const done = sheet.locator("li", { hasText: "Toggle done" });
	await expect(done.locator("kbd")).toHaveText("x");
});

// Chromium synthesizes pointer events from CDP touches, which is what the
// long-press listens to; Playwright's touchscreen API only offers a tap.
async function longPress(page: Page, target: Locator) {
	const box = await target.boundingBox();
	if (!box) throw new Error("long-press target has no box");
	const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Input.dispatchTouchEvent", {
		type: "touchStart",
		touchPoints: [point],
	});
	await page.waitForTimeout(700);
	await cdp.send("Input.dispatchTouchEvent", {
		type: "touchEnd",
		touchPoints: [],
	});
	await cdp.detach();
}

async function phone(browser: Browser) {
	// Two lists, so Move has somewhere to go.
	const ctx = await browser.newContext({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});
	const page = await ctx.newPage();
	await signUp(page, uniqueEmail("bulk-touch"));
	await waitWorkspaceReady(page);
	expect(
		await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
	).toBe(true);
	for (const name of ["Home", "Errands"]) {
		await page.getByRole("button", { name: "New list" }).click();
		await page.getByTestId("new-list").fill(name);
		await page.getByTestId("new-list-submit").click();
		await expect(
			page.getByTestId("list-index").getByRole("button", { name, exact: true }),
		).toBeVisible({ timeout: 15000 });
	}
	await page
		.getByTestId("list-index")
		.getByRole("button", { name: "Errands", exact: true })
		.click();
	await expect(page.getByTestId("list")).toBeVisible({ timeout: 15000 });
	return { ctx, page };
}

test("touch: long-press Select starts selection mode and taps then select", async ({
	browser,
}) => {
	const { ctx, page } = await phone(browser);
	await addTasks(page, ["Tap one", "Tap two", "Tap three"]);

	// No select control takes space on a touch row until selection starts.
	const control = row(page, "Tap two").getByTestId("task-select");
	expect((await control.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);

	await longPress(page, openButton(page, "Tap one"));
	await page.getByTestId("row-action-select").click();
	const bar = page.getByTestId("selection-bar");
	await expect(bar).toBeVisible();
	await expect(page.getByTestId("selection-count")).toHaveText(
		"1 task selected",
	);
	// Move stays reachable on a phone (the bar wraps rather than clipping).
	await expect(bar.getByTestId("selection-move")).toBeInViewport();
	// A tap now selects instead of opening the task.
	await openButton(page, "Tap three").tap();
	await expect(page.getByTestId("selection-count")).toHaveText(
		"2 tasks selected",
	);
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect((await control.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44);
	// The floating add button steps aside for the bar.
	await expect(
		page.getByRole("button", { name: "Quick add", exact: true }),
	).toBeHidden();
	await expectNoSeriousA11y(page, "touch selection mode");

	await bar.getByTestId("selection-clear").tap();
	await expect(bar).toHaveCount(0);
	await openButton(page, "Tap two").tap();
	await expect(page.getByRole("dialog")).toBeVisible();
	await ctx.close();
});

// Another device completes a selected row: it settles into the collapsed
// completed group, so it leaves the selection and a bulk delete never reaches it.
async function completeElsewhere(title: string): Promise<void> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await pool.query("update task set done = true where title = $1", [title]);
	} finally {
		await pool.end();
	}
}

test("a selected row that leaves the screen leaves the selection", async ({
	page,
}) => {
	await setupList(page, "bulk-hidden", ["Hide me", "Keep me", "Other"]);
	await openButton(page, "Hide me").click({ modifiers: ["ControlOrMeta"] });
	await openButton(page, "Keep me").click({ modifiers: ["ControlOrMeta"] });
	await expect(page.getByTestId("selection-count")).toHaveText(
		"2 tasks selected",
	);
	await completeElsewhere("Hide me");
	await expect(
		page.getByTestId("list").getByTestId("completed-section"),
	).toBeVisible({ timeout: 15000 });
	await expect(page.getByTestId("selection-count")).toHaveText(
		"1 task selected",
	);
	await page.getByTestId("selection-delete").click();
	const confirm = page.getByRole("alertdialog");
	await expect(confirm).toContainText("Delete 1 task?");
	await confirm.getByRole("button", { name: "Delete" }).click();
	await expect(page.getByText("Keep me", { exact: true })).toHaveCount(0);
	await page.getByTestId("list").getByTestId("completed-section").click();
	await expect(
		page.getByTestId("list").getByRole("checkbox", { name: "Hide me" }),
	).toBeChecked();
});

test("Ctrl/Cmd+A outside the list stays the page's own", async ({ page }) => {
	await setupList(page, "bulk-ctrl-a", ["Only row"]);
	await page.getByTestId("new-task").focus();
	await page.keyboard.press("ControlOrMeta+a");
	await expect(page.getByTestId("selection-bar")).toHaveCount(0);
	await page.evaluate(() => (document.activeElement as HTMLElement).blur());
	await page.keyboard.press("ControlOrMeta+a");
	await expect(page.getByTestId("selection-bar")).toHaveCount(0);
});

test("saved views select across their rows and complete in bulk", async ({
	page,
}) => {
	await setupList(page, "bulk-view", ["View one", "View two"]);
	await sidebarLists(page)
		.getByRole("button", { name: "All my tasks", exact: true })
		.click();
	await expect(page.getByTestId("view-surface")).toBeVisible();
	const surface = "view-renderer";
	await row(page, "View one", surface)
		.getByRole("button", { name: "Open details" })
		.click({ modifiers: ["ControlOrMeta"] });
	await row(page, "View two", surface)
		.getByRole("button", { name: "Open details" })
		.click({ modifiers: ["ControlOrMeta"] });
	await expect(page.getByTestId("selection-count")).toHaveText(
		"2 tasks selected",
	);
	// Both rows live in one workspace, so Move is offered.
	await expect(page.getByTestId("selection-move")).toBeVisible();
	await page.getByTestId("selection-complete").click();
	await expect(page.getByTestId("snackbar")).toContainText(
		"Completed 2 tasks.",
	);
	await page.getByTestId("snackbar").getByTestId("snackbar-action").click();
	await expect(
		page
			.getByTestId(surface)
			.getByRole("checkbox", { name: "View one", exact: true }),
	).not.toBeChecked();
});

test("shopping lists check, clear amounts and uncheck in bulk", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("bulk-shop"));
	await waitWorkspaceReady(page);
	await page.getByTestId("sidebar-create").click();
	await page.getByTestId("sidebar-new-list").click();
	await page.getByTestId("new-list").fill("Groceries");
	await page.getByRole("button", { name: "Shopping", exact: true }).click();
	await page.getByTestId("new-list-submit").click();
	await openList(page, "Groceries");
	await addTasks(page, ["Milk", "Bread"]);
	await row(page, "Milk").hover();
	await row(page, "Milk").getByTestId("shopping-qty-add").click();
	await page.locator("input[aria-label='Quantity for Milk']").fill("2");
	await page.keyboard.press("Enter");
	await expect(
		row(page, "Milk").getByTestId("shopping-qty-chip"),
	).toBeVisible();

	await row(page, "Milk").locator("[data-kbd-nav]").focus();
	await page.keyboard.press("ControlOrMeta+a");
	const bar = page.getByTestId("selection-bar");
	await expect(page.getByTestId("selection-count")).toHaveText(
		"2 tasks selected",
	);
	await expect(bar.getByTestId("selection-due")).toHaveCount(0);
	await bar.getByTestId("selection-clear-quantity").click();
	await expect(row(page, "Milk").getByTestId("shopping-qty-chip")).toHaveCount(
		0,
	);
	await bar.getByTestId("selection-complete").click();
	await expect(page.getByTestId("snackbar")).toContainText("Checked 2 items.");
	const inCart = page.getByTestId("list").getByTestId("completed-section");
	await expect(inCart).toBeVisible({ timeout: 5000 });
	await inCart.click();
	await row(page, "Milk").locator("[data-kbd-nav]").focus();
	await page.keyboard.press("ControlOrMeta+a");
	await page.getByTestId("selection-uncheck").click();
	await expect(inCart).toHaveCount(0, { timeout: 5000 });
	await expect(
		page.getByTestId("list").getByRole("checkbox", { name: "Bread" }),
	).not.toBeChecked();
});
