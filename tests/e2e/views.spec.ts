import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { Pool } from "pg";

// M1c views + keyboard e2e. Exercises the saved-view lifecycle (build/save/
// round-trip), the layout switch + board regroup, the command palette, the
// single-key/sequence key handler with the input-skip rule, remap + vim, the
// cheat-sheet, the Today landing, and the mobile board->list collapse. Plus the
// axe merge gate on every new surface. Conventions (signUp/uniqueEmail/testid
// locators/frozen-frame axe) mirror domain.spec + sharing.spec. These are all
// single-client tests, so they use the built-in auto-closing `page` fixture --
// that guarantees the context is disposed even on failure, so one flake can
// never leak a context and cascade into the following tests' signups.

// views.spec is the last file in the run, so the shared single dev server + zero-
// cache are the warmest here: signup/shell-mount latency creeps up under the
// accumulated load. Scope a couple of retries + generous per-test budget to THIS
// file only (domain/sharing keep the project defaults) so a load-induced slow
// signup retries instead of failing the suite.
test.describe.configure({ retries: 2, timeout: 90_000 });

const PASSWORD = "pw-123456";
const SIGNUP_TIMEOUT = 30_000;

let emailSeq = 0;
function uniqueEmail(prefix: string): string {
	emailSeq += 1;
	return `${prefix}-${Date.now()}-${emailSeq}@t.dev`;
}

// One get-session call, matching the model specs. `/api/auth/get-session` keeps
// the default rate limit (only sign-in/up are relaxed under DITERO_E2E), so it
// must NOT be polled -- a poll loop trips the limiter at the tail and starves the
// app's own session checks. Tests that need the user resolve it from the DB by
// email instead (seedOverdueTask), so no session round-trip is needed here.
async function signUp(page: Page, email: string): Promise<void> {
	await page.goto("/");
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill(PASSWORD);
	await page.getByTestId("signup").click();
	await expect(page.getByTestId("workspace")).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
}

// Desktop sidebar list/view nav (aria-label "Lists"): scopes clicks away from the
// mobile index + create-list controls that share their labels with titles.
function sidebarLists(page: Page): Locator {
	return page.getByRole("navigation", { name: "Lists" });
}

async function waitWorkspaceReady(page: Page): Promise<void> {
	await expect(page.getByRole("button", { name: /'s space/ })).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
}

async function createListDesktop(page: Page, name: string): Promise<void> {
	await waitWorkspaceReady(page);
	await page.getByTestId("new-list").fill(name);
	await page.getByTestId("new-list-submit").click();
	await expect(
		sidebarLists(page).getByRole("button", { name, exact: true }).first(),
	).toBeVisible({ timeout: 15000 });
}

async function openListDesktop(page: Page, name: string): Promise<void> {
	await sidebarLists(page)
		.getByRole("button", { name, exact: true })
		.last()
		.click();
	await expect(page.getByTestId("list")).toBeVisible();
}

async function addTask(page: Page, title: string): Promise<void> {
	await page.getByTestId("new-task").fill(title);
	await page.getByTestId("new-task-submit").click();
	await expect(
		page.getByTestId("list").getByText(title, { exact: true }),
	).toBeVisible({ timeout: 15000 });
}

// Drop the currently-focused element so keyboard.press targets <body>, not a
// text field: the single-key/sequence handler is inert inside inputs by design.
async function blur(page: Page): Promise<void> {
	await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

// Radix Select: open the trigger, click the option (rendered in a body portal).
async function pickSelect(
	page: Page,
	trigger: Locator,
	option: string,
): Promise<void> {
	await trigger.click();
	await page.getByRole("option", { name: option, exact: true }).click();
}

// A ViewManager labeled Select (Layout, Group by, ...). Exact so "Layout" never
// matches a view-surface whose aria-label is a name like "Layouts".
async function pickLabeled(
	page: Page,
	label: string,
	option: string,
): Promise<void> {
	await pickSelect(page, page.getByLabel(label, { exact: true }), option);
}

// Exact match: the depth-0 GroupCard fieldset is "Filter conditions" (plural),
// which a substring match would also catch and shift every row index by one.
function conditionRow(page: Page, i: number): Locator {
	return page
		.getByRole("group", { name: "Filter condition", exact: true })
		.nth(i);
}

// Seed a list + task straight into the user's personal workspace, the way
// sharing.spec seeds via a Pool. Resolve the user + workspace by email (no
// session fetch). `overdue` sets a past due date (Today-view fixture); otherwise
// the task has no due date. zero-cache replicates it; callers reload so the
// client re-subscribes and picks it up.
async function seedPersonalTask(
	email: string,
	title: string,
	opts: { overdue?: boolean } = {},
): Promise<void> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		const rows = await pool.query<{ wsId: string; ownerId: string }>(
			`select w.id as "wsId", w.owner_id as "ownerId"
			 from workspace w join "user" u on u.id = w.owner_id
			 where u.email = $1 and w.kind = 'personal'`,
			[email],
		);
		const row = rows.rows[0];
		if (!row) throw new Error("personal workspace not found");
		const listId = crypto.randomUUID();
		await pool.query(
			`insert into list (id, workspace_id, owner_id, title, kind, sort_key)
			 values ($1, $2, $3, 'Seeded list', 'tasks', 'a0')`,
			[listId, row.wsId, row.ownerId],
		);
		// The interval literal is fixed, not user input.
		const dueSql = opts.overdue ? "now() - interval '2 days'" : "null";
		await pool.query(
			`insert into task (id, list_id, title, sort_key, due_at, done, priority)
			 values ($1, $2, $3, 'a0', ${dueSql}, false, 0)`,
			[crypto.randomUUID(), listId, title],
		);
	} finally {
		await pool.end();
	}
}

// Gate per design 2.14: zero serious/critical violations. Freeze animations so
// axe samples the settled frame (matches domain.spec/sharing.spec exactly).
async function expectNoSeriousA11y(page: Page, surface: string): Promise<void> {
	await page.addStyleTag({
		content:
			"*,*::before,*::after{animation:none!important;transition:none!important}",
	});
	const { violations } = await new AxeBuilder({ page }).analyze();
	const serious = violations.filter(
		(v) => v.impact === "serious" || v.impact === "critical",
	);
	const minor = violations.filter(
		(v) => v.impact !== "serious" && v.impact !== "critical",
	);
	if (minor.length > 0)
		console.log(
			`a11y[${surface}] moderate/minor:`,
			minor.map((v) => v.id).join(", "),
		);
	if (serious.length > 0)
		console.error(
			`a11y[${surface}] serious/critical:`,
			JSON.stringify(
				serious.map((v) => ({ id: v.id, nodes: v.nodes.length })),
				null,
				2,
			),
		);
	expect(serious, `serious/critical a11y violations on ${surface}`).toEqual([]);
}

// --- Scenario 1: build + save a view; it appears in the sidebar and round-trips ---
test("view: build priority+assignee filter, save, appears in sidebar, round-trips", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("v1"));
	await waitWorkspaceReady(page);

	const viewName = `Hot for me ${Date.now()}`;
	await page.getByTestId("new-view").click();
	await page.getByTestId("view-name").fill(viewName);

	// Condition 0: priority is High.
	await page.getByTestId("add-condition").click();
	await pickSelect(
		page,
		conditionRow(page, 0).getByTestId("field-select"),
		"Priority",
	);
	await pickSelect(
		page,
		conditionRow(page, 0).getByTestId("value-control"),
		"High",
	);

	// Condition 1: assignee includes me (assignee defaults to the "me" token).
	await page.getByTestId("add-condition").click();
	await pickSelect(
		page,
		conditionRow(page, 1).getByTestId("field-select"),
		"Assignee",
	);
	await expect(
		conditionRow(page, 1).getByTestId("value-control"),
	).toContainText("Me");

	await page.getByTestId("view-save").click();

	// The saved view lands in the sidebar Views section and opens.
	await expect(
		sidebarLists(page).getByRole("button", { name: viewName, exact: true }),
	).toBeVisible({ timeout: 15000 });
	await expect(page.getByTestId("view-surface")).toBeVisible();

	// Reopen from the sidebar (navigate to Today first to prove it reopens).
	await sidebarLists(page)
		.getByRole("button", { name: "Today", exact: true })
		.click();
	await sidebarLists(page)
		.getByRole("button", { name: viewName, exact: true })
		.click();
	await expect(page.getByTestId("view-surface")).toBeVisible();

	// Edit and assert the saved conditions round-tripped into the builder.
	await page.getByTestId("view-actions").click();
	await page.getByTestId("view-edit").click();
	await expect(page.getByTestId("view-name")).toHaveValue(viewName);
	await expect(
		page.getByTestId("field-select").filter({ hasText: "Priority" }),
	).toHaveCount(1);
	await expect(
		page.getByTestId("value-control").filter({ hasText: "High" }),
	).toHaveCount(1);
	await expect(
		page.getByTestId("field-select").filter({ hasText: "Assignee" }),
	).toHaveCount(1);
});

// --- Scenario 2: switch layout list -> board -> table on a view ---
test("view: layout switch renders board columns then a real table", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("v2"));
	await waitWorkspaceReady(page);

	await createListDesktop(page, "L2");
	await openListDesktop(page, "L2");
	await addTask(page, "T2 item");

	// New view, empty filter (matches all my tasks), list layout to start.
	const viewName = `Switcher ${Date.now()}`;
	await page.getByTestId("new-view").click();
	await page.getByTestId("view-name").fill(viewName);
	await page.getByTestId("view-save").click();
	await expect(page.getByTestId("view-surface")).toBeVisible();

	// -> Board grouped by priority: the four fixed columns render as regions.
	await page.getByTestId("view-actions").click();
	await page.getByTestId("view-edit").click();
	await pickLabeled(page, "Layout", "Board");
	await pickLabeled(page, "Group by", "Priority");
	await page.getByTestId("view-save").click();
	for (const col of ["High", "Medium", "Low", "None"]) {
		await expect(page.getByRole("region", { name: col })).toBeVisible({
			timeout: 15000,
		});
	}

	// -> Table: a real <table> with sortable column headers.
	await page.getByTestId("view-actions").click();
	await page.getByTestId("view-edit").click();
	await pickLabeled(page, "Layout", "Table");
	await page.getByTestId("view-save").click();
	await expect(page.getByRole("table")).toBeVisible({ timeout: 15000 });
	for (const header of ["Title", "Due", "Priority", "Assignees", "List"]) {
		await expect(
			page.getByRole("columnheader", { name: header, exact: true }),
		).toBeVisible();
	}
});

// --- Scenario 3: board drag regroup persists the priority scalar ---
test("view: dragging a card to another priority column regroups + persists", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("v3"));
	await waitWorkspaceReady(page);

	await createListDesktop(page, "L3");
	await openListDesktop(page, "L3");
	const cardTitle = "Drag me";
	await addTask(page, cardTitle);

	const viewName = `Kanban ${Date.now()}`;
	await page.getByTestId("new-view").click();
	await page.getByTestId("view-name").fill(viewName);
	await pickLabeled(page, "Layout", "Board");
	await pickLabeled(page, "Group by", "Priority");
	await page.getByTestId("view-save").click();
	await expect(page.getByTestId("view-surface")).toBeVisible();

	// The card starts in the "None" (priority 0) column.
	const none = page.getByRole("region", { name: "None" });
	const high = page.getByRole("region", { name: "High" });
	await expect(none.getByText(cardTitle, { exact: true })).toBeVisible({
		timeout: 15000,
	});

	// Drag the card handle into the High column. Intermediate pointer steps clear
	// dnd-kit's activation distance; a cross-column drop writes priority=3.
	const handle = await page
		.getByTestId("board-card-handle")
		.first()
		.boundingBox();
	const target = await high.boundingBox();
	if (!handle || !target) throw new Error("missing drag targets");
	await page.mouse.move(
		handle.x + handle.width / 2,
		handle.y + handle.height / 2,
	);
	await page.mouse.down();
	await page.mouse.move(
		handle.x + handle.width / 2,
		handle.y + handle.height / 2 + 12,
		{ steps: 6 },
	);
	await page.mouse.move(
		target.x + target.width / 2,
		target.y + target.height / 2,
		{ steps: 20 },
	);
	await page.mouse.move(
		target.x + target.width / 2,
		target.y + target.height / 2 + 4,
		{ steps: 5 },
	);
	await page.mouse.up();

	// Regrouped: the card now sits under High.
	await expect(high.getByText(cardTitle, { exact: true })).toBeVisible({
		timeout: 15000,
	});

	// Persists across a reload (priority scalar written, not a transient sort).
	await page.reload();
	await waitWorkspaceReady(page);
	await sidebarLists(page)
		.getByRole("button", { name: viewName, exact: true })
		.click();
	await expect(page.getByTestId("view-surface")).toBeVisible();
	await expect(
		page
			.getByRole("region", { name: "High" })
			.getByText(cardTitle, { exact: true }),
	).toBeVisible({ timeout: 15000 });
});

// --- Scenario 4: command palette runs a command + navigates a search hit ---
test("palette: Meta+K opens, runs New task, and a search hit opens its list", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("v4"));
	await waitWorkspaceReady(page);

	await createListDesktop(page, "PaletteList");
	await openListDesktop(page, "PaletteList");
	await addTask(page, "Findme palette task");

	// Palette opens; "New task" command runs and opens the quick-add sheet.
	await page.keyboard.press("ControlOrMeta+k");
	const palette = page.getByRole("combobox", {
		name: "Command palette search",
	});
	await expect(palette).toBeVisible();
	await palette.fill("New task");
	await expect(page.getByRole("option", { name: "New task" })).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("quickadd-input")).toBeVisible();
	await page.keyboard.press("Escape");
	// Wait for the sheet + its overlay to fully tear down before navigating, else
	// the closing overlay can intercept the next click (pointer-events race).
	await expect(page.getByTestId("quickadd-input")).toBeHidden({
		timeout: 15000,
	});

	// Move off the list so the search navigation is observable as a fresh open.
	await sidebarLists(page)
		.getByRole("button", { name: "Today", exact: true })
		.click();
	await expect(page.getByTestId("view-surface")).toBeVisible();

	// Reopen the palette, search a task title, activate the hit -> its list opens.
	await page.keyboard.press("ControlOrMeta+k");
	await expect(palette).toBeVisible();
	await palette.fill("Findme");
	await expect(page.getByRole("option", { name: /Findme/ })).toBeVisible({
		timeout: 15000,
	});
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("list")).toBeVisible();
	await expect(
		page.getByTestId("list").getByText("Findme palette task", { exact: true }),
	).toBeVisible();
});

// --- Scenario 5: single-key opens quick-add, is inert in inputs, g-t goes Today ---
test("keys: c opens quick-add, is skipped in inputs, g t opens Today", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("v5"));
	await waitWorkspaceReady(page);

	// Focus outside inputs: `c` opens the quick-add sheet.
	await blur(page);
	await page.keyboard.press("c");
	await expect(page.getByTestId("quickadd-input")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("quickadd-input")).toBeHidden({
		timeout: 15000,
	});

	// Inside a text input: `c` types, never fires the shortcut.
	await page.getByTestId("new-list").click();
	await page.keyboard.press("c");
	await expect(page.getByTestId("quickadd-input")).toHaveCount(0);

	// g then t navigates to Today from an open list.
	await createListDesktop(page, "L5");
	await openListDesktop(page, "L5");
	await blur(page);
	await page.keyboard.press("g");
	await page.keyboard.press("t");
	await expect(
		page.getByRole("heading", { name: "Today", level: 1 }),
	).toBeVisible({ timeout: 15000 });
	await expect(page.getByTestId("list")).toHaveCount(0);
});

// --- Scenario 5b: roving j/k moves row focus, x toggles, o opens detail ---
test("keys: j/k move task-row focus, x toggles done, o opens detail", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("v5b"));
	await waitWorkspaceReady(page);

	await createListDesktop(page, "L5b");
	await openListDesktop(page, "L5b");
	await addTask(page, "Row A");
	await addTask(page, "Row B");

	// The roving targets are the per-row open buttons TaskRow marks [data-kbd-nav].
	const navs = page.getByTestId("list").locator("[data-kbd-nav]");
	await expect(navs).toHaveCount(2);

	// j walks down the rows, k walks back up.
	await blur(page);
	await page.keyboard.press("j");
	await expect(navs.nth(0)).toBeFocused();
	await page.keyboard.press("j");
	await expect(navs.nth(1)).toBeFocused();
	await page.keyboard.press("k");
	await expect(navs.nth(0)).toBeFocused();

	// o opens the focused row's detail (clicks the nav element).
	await page.keyboard.press("o");
	const detail = page.getByRole("dialog");
	await expect(detail.getByLabel("Task title")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(detail).toBeHidden({ timeout: 15000 });

	// x toggles the focused row's checkbox done. Re-focus row 0 deterministically
	// first (Escape may not restore focus to a nav element).
	await blur(page);
	await page.keyboard.press("j");
	await page.keyboard.press("x");
	await expect(
		page.getByTestId("list").getByRole("checkbox", { name: "Row A" }),
	).toBeChecked({ timeout: 15000 });
});

// --- Scenario 6: remap a command, verify it persists + fires; vim reflected ---
test("keymap: rebind persists across reload and fires; vim profile reflected", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("v6"));
	await waitWorkspaceReady(page);

	// Rebind "New task" (task.create) to `n`.
	const rebind = page.getByTestId("keymap-rebind-task.create");
	await rebind.scrollIntoViewIfNeeded();
	await rebind.click();
	await expect(page.getByTestId("keymap-capture")).toBeVisible();
	await page.keyboard.press("n");
	await expect(page.getByTestId("keymap-draft")).toBeVisible();
	await page.getByTestId("keymap-save").click();

	// Persisted: after a reload the cheat-sheet shows the new binding.
	await page.reload();
	await waitWorkspaceReady(page);
	await blur(page);
	await page.keyboard.press("?");
	const cheat = page.getByRole("dialog");
	await expect(
		cheat.getByRole("heading", { name: "Keyboard shortcuts" }),
	).toBeVisible();
	await expect(
		cheat
			.locator("li", { hasText: "New task" })
			.getByText("n", { exact: true }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(cheat).toBeHidden();

	// Active: the rebound key fires the command.
	await blur(page);
	await page.keyboard.press("n");
	await expect(page.getByTestId("quickadd-input")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("quickadd-input")).toBeHidden({
		timeout: 15000,
	});

	// Vim profile: selecting it flips the pressed state (movement stays j/k/o/x in
	// both profiles, so there is no vim-only binding to assert post-M1c).
	await page.getByTestId("keymap-profile-vim").click();
	await expect(page.getByTestId("keymap-profile-vim")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
});

// --- Scenario 7: cheat-sheet lists command bindings ---
test("cheat-sheet: ? opens the overlay listing command bindings", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("v7"));
	await waitWorkspaceReady(page);

	await blur(page);
	await page.keyboard.press("?");
	const cheat = page.getByRole("dialog");
	await expect(
		cheat.getByRole("heading", { name: "Keyboard shortcuts" }),
	).toBeVisible();
	// A known command label and its ⌘K chord render together.
	const row = cheat.locator("li", { hasText: "Command palette" });
	await expect(row).toBeVisible();
	await expect(row.locator("kbd").filter({ hasText: "K" })).toBeVisible();
});

// --- Scenario 8: fresh user lands on Today; an overdue task shows there ---
test("today: fresh landing is the Today view and shows an overdue task", async ({
	page,
}) => {
	const email = uniqueEmail("v8");
	await signUp(page, email);
	await waitWorkspaceReady(page);

	// The default landing is the Today view.
	await expect(page.getByTestId("view-surface")).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Today", level: 1 }),
	).toBeVisible();

	// Seed an overdue task, reload, and see it inside the Today surface.
	const title = `Overdue-${Date.now()}`;
	await seedPersonalTask(email, title, { overdue: true });
	await page.reload();
	await waitWorkspaceReady(page);
	await expect(
		page.getByRole("heading", { name: "Today", level: 1 }),
	).toBeVisible();
	await expect(
		page.getByTestId("view-surface").getByText(title, { exact: true }),
	).toBeVisible({ timeout: 15000 });
});

// --- Scenario 9: a board view collapses to a grouped list on mobile ---
test("mobile: a board view degrades to the grouped list affordance", async ({
	page,
}) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const email = uniqueEmail("v9");
	await signUp(page, email);
	await waitWorkspaceReady(page);

	// Seed a task so the board view has real content: this makes the collapse a
	// meaningful negative (a board would render a draggable card; the list does
	// not), not a vacuous one. Reload so the client syncs it before the view opens.
	const taskTitle = `Mobile task ${Date.now()}`;
	await seedPersonalTask(email, taskTitle);
	await page.reload();
	await waitWorkspaceReady(page);

	// Mobile landing surfaces a New view control in its Views nav.
	await page.getByTestId("new-view").click();
	await page.getByTestId("view-name").fill(`Mini board ${Date.now()}`);
	await pickLabeled(page, "Layout", "Board");
	await pickLabeled(page, "Group by", "Priority");
	await page.getByTestId("view-save").click();

	// The board is shown as a list: the "Viewing as list" note is present, the
	// seeded task renders as a list row, and the board-only card handle
	// (`board-card-handle`, emitted only by BoardLayout columns) is absent -- so
	// the assertion proves collapse even though a groupable task exists.
	await expect(page.getByTestId("view-surface")).toBeVisible();
	await expect(page.getByText("Viewing as list")).toBeVisible({
		timeout: 15000,
	});
	await expect(
		page.getByTestId("view-surface").getByText(taskTitle, { exact: true }),
	).toBeVisible({ timeout: 15000 });
	await expect(page.getByTestId("board-card-handle")).toHaveCount(0);
});

// --- Axe merge gate on the new views + keyboard surfaces ---
test("a11y: no serious/critical violations on views + keyboard surfaces", async ({
	page,
}) => {
	test.setTimeout(120000);
	await signUp(page, uniqueEmail("axe-views"));
	await waitWorkspaceReady(page);

	// Keymap settings live on the desktop landing (beside Security).
	await expect(page.getByTestId("keymap-profile-default")).toBeVisible();
	await expectNoSeriousA11y(page, "keymap settings (landing)");

	await createListDesktop(page, "AxeList");
	await openListDesktop(page, "AxeList");
	await addTask(page, "Axe item");

	// Filter builder inside the New view form (with a condition row present).
	await page.getByTestId("new-view").click();
	await page.getByTestId("view-name").fill(`Axe view ${Date.now()}`);
	await page.getByTestId("add-condition").click();
	await expect(conditionRow(page, 0)).toBeVisible();
	await expectNoSeriousA11y(page, "filter builder");

	// Save it as a priority board, then axe the board layout.
	await pickLabeled(page, "Layout", "Board");
	await pickLabeled(page, "Group by", "Priority");
	await page.getByTestId("view-save").click();
	await expect(page.getByRole("region", { name: "None" })).toBeVisible({
		timeout: 15000,
	});
	await expectNoSeriousA11y(page, "board layout");

	// Switch to table and axe it.
	await page.getByTestId("view-actions").click();
	await page.getByTestId("view-edit").click();
	await pickLabeled(page, "Layout", "Table");
	await page.getByTestId("view-save").click();
	await expect(page.getByRole("table")).toBeVisible({ timeout: 15000 });
	await expectNoSeriousA11y(page, "table layout");

	// Command palette.
	await page.keyboard.press("ControlOrMeta+k");
	await expect(
		page.getByRole("combobox", { name: "Command palette search" }),
	).toBeVisible();
	await expectNoSeriousA11y(page, "command palette");
	await page.keyboard.press("Escape");

	// Cheat-sheet.
	await blur(page);
	await page.keyboard.press("?");
	await expect(
		page
			.getByRole("dialog")
			.getByRole("heading", { name: "Keyboard shortcuts" }),
	).toBeVisible();
	await expectNoSeriousA11y(page, "cheat-sheet");
});
