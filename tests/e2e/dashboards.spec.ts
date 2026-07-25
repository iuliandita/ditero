import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import { browserToday, shiftDay } from "../support/browser-day.ts";

// M-dash dashboards e2e. Exercises the dashboard lifecycle (create from the
// sidebar, empty state, add view-ref/inline panels), live task completion from
// a panel (task.complete wiring), edit mode (drag reorder + persist, resize,
// remove), sharing (workspace-shared visible to members only, personal stays
// private, viewer read-only), the seeded streak + focus panels, keyboard/
// palette/home navigation, and the axe merge gate on every new surface.
// Conventions (signUp/uniqueEmail/testid locators/pg seeding/frozen-frame axe)
// mirror views.spec + habits.spec + sharing.spec.
test.describe.configure({ retries: 2, timeout: 90_000 });

const SHARED_WORKSPACE_ID = "w_shared_e2e";
const PASSWORD = "pw-123456";
const SIGNUP_TIMEOUT = 30_000;

let emailSeq = 0;
function uniqueEmail(prefix: string): string {
	emailSeq += 1;
	return `${prefix}-${Date.now()}-${emailSeq}@t.dev`;
}

async function signUp(page: Page, email: string): Promise<void> {
	await page.goto("/");
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill(PASSWORD);
	await page.getByTestId("signup").click();
	await expect(page.getByTestId("workspace")).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
}

// Sharing scenario only: one get-session call per user (never polled) to learn
// the id for direct membership seeding, matching sharing.spec.
async function signUpWithId(page: Page, email: string): Promise<string> {
	await signUp(page, email);
	const session = await page.evaluate(async () => {
		const response = await fetch("/api/auth/get-session");
		return (await response.json()) as { user: { id: string } };
	});
	return session.user.id;
}

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

// Drop focus so single-key/sequence shortcuts fire (inert inside inputs).
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

// New dashboard via the sidebar control; scope defaults to personal, or
// workspace-shared when a workspace name is given. Waits for the manager
// dialog teardown so its overlay can't intercept the next click.
async function createDashboard(
	page: Page,
	name: string,
	opts: { workspace?: string } = {},
): Promise<void> {
	await page.getByTestId("new-dashboard").click();
	await page.getByTestId("dashboard-name").fill(name);
	if (opts.workspace) {
		await pickSelect(
			page,
			page.getByLabel("Visibility", { exact: true }),
			"Workspace",
		);
		await pickSelect(
			page,
			page.getByLabel("Shared in", { exact: true }),
			opts.workspace,
		);
	}
	await page.getByTestId("dashboard-save").click();
	await expect(page.getByTestId("dashboard-surface")).toBeVisible({
		timeout: 15000,
	});
	await expect(page.getByTestId("dashboard-name")).toBeHidden({
		timeout: 15000,
	});
}

async function openDashboardFromSidebar(
	page: Page,
	name: string,
): Promise<void> {
	await sidebarLists(page).getByRole("button", { name, exact: true }).click();
	await expect(page.getByTestId("dashboard-surface")).toBeVisible({
		timeout: 15000,
	});
}

// AddPanelDialog teardown wait: the closing dialog overlay can otherwise
// intercept the next grid click (same race views.spec guards on the quickadd
// sheet).
async function expectPanelDialogClosed(page: Page): Promise<void> {
	await expect(page.getByTestId("panel-save")).toBeHidden({ timeout: 15000 });
}

// Add a focus panel with an explicit title (the simplest panel type: no
// source/habit dependencies), used where scenarios only need named panels.
async function addFocusPanel(
	page: Page,
	opener: Locator,
	title: string,
): Promise<void> {
	await opener.click();
	await page.getByTestId("panel-type-focus").click();
	await page.getByTestId("panel-title").fill(title);
	await page.getByTestId("panel-save").click();
	await expectPanelDialogClosed(page);
	await expect(page.getByRole("region", { name: title })).toBeVisible({
		timeout: 15000,
	});
}

// Seed a habits list + one daily habit with done logs (today + yesterday, so
// current streak = 2) and two 10-minute work focus sessions, straight into the
// user's personal workspace (views.spec seeding pattern; callers reload so the
// client re-subscribes). `today` must be the BROWSER's local day: habit_log
// dates are the user's local day (habitDay), which this process's zone only
// agrees with for part of the day.
async function seedHabitAndFocus(
	email: string,
	habitTitle: string,
	today: string,
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
			 values ($1, $2, $3, 'Seeded habits', 'habits', 'a0')`,
			[listId, row.wsId, row.ownerId],
		);
		const habitId = crypto.randomUUID();
		await pool.query(
			`insert into task (id, list_id, title, sort_key, rrule)
			 values ($1, $2, $3, 'a0', 'FREQ=DAILY')`,
			[habitId, listId, habitTitle],
		);
		for (const date of [today, shiftDay(today, -1)]) {
			await pool.query(
				`insert into habit_log (id, habit_id, date, status)
				 values ($1, $2, $3, 'done')`,
				[crypto.randomUUID(), habitId, date],
			);
		}
		for (let i = 0; i < 2; i++) {
			await pool.query(
				`insert into focus_session (id, user_id, kind, started_at, ended_at, duration_sec)
				 values ($1, $2, 'work', now(), now(), 600)`,
				[crypto.randomUUID(), row.ownerId],
			);
		}
	} finally {
		await pool.end();
	}
}

// Poll upstream Postgres until `read` returns `expected`: an expect-based sync
// barrier for reload-persistence checks (never an arbitrary sleep).
async function expectServerState<T>(
	read: (pool: Pool) => Promise<T>,
	expected: T,
): Promise<void> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await expect.poll(() => read(pool), { timeout: 15000 }).toEqual(expected);
	} finally {
		await pool.end();
	}
}

// Sharing scenario: add `userId` to the globally seeded shared workspace at
// `role` (direct upstream write; zero-cache replicates), same as sharing.spec.
async function joinShared(
	userId: string,
	role: "owner" | "admin" | "member" | "viewer",
): Promise<void> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await pool.query(
			`insert into membership (id, user_id, workspace_id, role)
			 values ($1, $2, $3, $4)`,
			[crypto.randomUUID(), userId, SHARED_WORKSPACE_ID, role],
		);
	} finally {
		await pool.end();
	}
}

// Gate per design 2.14: zero serious/critical violations. Freeze animations so
// axe samples the settled frame (matches views.spec exactly).
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

// --- Scenarios 1+2: create dashboard, add view-ref + inline panels, complete
// a task from the panel and see the counter drop (task.complete wiring) ---
test("dashboard: sidebar create, view-ref tasks panel + inline counter, completion drops the count", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("d1"));
	await waitWorkspaceReady(page);

	await createListDesktop(page, "D1");
	await openListDesktop(page, "D1");
	await addTask(page, "Dash task one");
	await addTask(page, "Dash task two");

	// A saved view (empty filter = all my tasks) to reference from the panel.
	const viewName = `Panel view ${Date.now()}`;
	await page.getByTestId("new-view").click();
	await page.getByTestId("view-name").fill(viewName);
	await page.getByTestId("view-save").click();
	await expect(page.getByTestId("view-surface")).toBeVisible({
		timeout: 15000,
	});

	// New dashboard from the sidebar -> opens on the empty state.
	const dashName = `Board ${Date.now()}`;
	await createDashboard(page, dashName);
	await expect(page.getByTestId("dashboard-empty")).toBeVisible();

	// Empty-state CTA enters edit mode and opens the add-panel dialog: a tasks
	// panel referencing the saved view.
	await page.getByTestId("dashboard-empty-add").click();
	await page.getByTestId("panel-type-tasks").click();
	await pickSelect(page, page.getByTestId("panel-view-pick"), viewName);
	await page.getByTestId("panel-save").click();
	await expectPanelDialogClosed(page);
	const tasksPanel = page.getByTestId("tasks-panel");
	await expect(
		tasksPanel.getByText("Dash task one", { exact: true }),
	).toBeVisible({ timeout: 15000 });
	await expect(
		tasksPanel.getByText("Dash task two", { exact: true }),
	).toBeVisible();

	// Second panel: an inline-filter counter over open (not done) tasks.
	await page.getByTestId("add-panel").click();
	await page.getByTestId("panel-type-counter").click();
	await pickSelect(
		page,
		page.getByTestId("panel-source-mode"),
		"Custom filter",
	);
	await page.getByTestId("add-condition").click();
	const condition = page
		.getByRole("group", { name: "Filter condition", exact: true })
		.first();
	await pickSelect(page, condition.getByTestId("field-select"), "Status");
	await pickSelect(page, condition.getByTestId("value-control"), "Not done");
	await page.getByTestId("panel-save").click();
	await expectPanelDialogClosed(page);
	await expect(page.getByTestId("counter-tile")).toHaveText("2", {
		timeout: 15000,
	});

	// Leave edit mode; both panels keep rendering.
	await page.getByTestId("dashboard-edit").click();
	await expect(page.getByTestId("dashboard-edit")).toHaveText("Edit");
	await expect(
		tasksPanel.getByText("Dash task one", { exact: true }),
	).toBeVisible();

	// Complete a task from the panel row: the row checks AND the counter drops,
	// proving the row routes through the live task.complete path.
	const checkbox = tasksPanel.getByRole("checkbox", { name: "Dash task one" });
	await checkbox.click();
	await expect(checkbox).toHaveAttribute("aria-checked", "true", {
		timeout: 15000,
	});
	await expect(page.getByTestId("counter-tile")).toHaveText("1", {
		timeout: 15000,
	});
});

// --- Scenario 3: edit mode reorder (persists), resize preset, remove ---
test("dashboard edit mode: drag reorder persists, size preset applies, remove with confirm", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("d3"));
	await waitWorkspaceReady(page);

	const dashName = `Editable ${Date.now()}`;
	await createDashboard(page, dashName);

	// Two named panels (focus type needs no source), added in edit mode.
	await addFocusPanel(page, page.getByTestId("dashboard-empty-add"), "Alpha");
	await addFocusPanel(page, page.getByTestId("add-panel"), "Beta");
	const frames = page.getByTestId("panel-frame");
	await expect(frames.nth(0)).toHaveAttribute("aria-label", "Alpha");
	await expect(frames.nth(1)).toHaveAttribute("aria-label", "Beta");

	// Drag Alpha's handle onto Beta -> order flips. Intermediate pointer steps
	// clear dnd-kit's activation distance (views.spec board pattern).
	const handle = await page
		.getByRole("region", { name: "Alpha" })
		.getByTestId("panel-drag")
		.boundingBox();
	const target = await page.getByRole("region", { name: "Beta" }).boundingBox();
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
	await expect(frames.nth(0)).toHaveAttribute("aria-label", "Beta", {
		timeout: 15000,
	});

	// The order persists across a reload (panels JSON written, not local state).
	await page.reload();
	await waitWorkspaceReady(page);
	await openDashboardFromSidebar(page, dashName);
	await expect(frames.nth(0)).toHaveAttribute("aria-label", "Beta", {
		timeout: 15000,
	});
	await expect(frames.nth(1)).toHaveAttribute("aria-label", "Alpha");

	// Re-enter edit mode; resize Beta to Full width via the "..." menu preset.
	await page.getByTestId("dashboard-edit").click();
	await expect(page.getByTestId("dashboard-edit")).toHaveText("Done");
	const beta = page.getByRole("region", { name: "Beta" });
	await beta.getByTestId("panel-menu").click();
	await page.getByTestId("panel-resize").click();
	await page.getByTestId("panel-size-full").click();
	await expect(beta.locator("..")).toHaveClass(/md:col-span-12/, {
		timeout: 15000,
	});

	// Remove Beta: window.confirm is accepted via the dialog handler.
	page.once("dialog", (dialog) => void dialog.accept());
	await beta.getByTestId("panel-menu").click();
	await page.getByTestId("panel-remove").click();
	await expect(page.getByRole("region", { name: "Beta" })).toHaveCount(0, {
		timeout: 15000,
	});
	await expect(page.getByRole("region", { name: "Alpha" })).toBeVisible();
});

// --- Scenario 4: sharing — workspace-shared visible to members only, personal
// stays private, viewer sees it read-only ---
test("dashboard sharing: member sees workspace dashboard, outsider and co-member of personal do not, viewer read-only", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const ctxOwner = await browser.newContext();
	const ctxMember = await browser.newContext();
	const ctxOutsider = await browser.newContext();
	const ctxViewer = await browser.newContext();
	try {
		const teamDash = `Team ${Date.now()}`;
		const soloDash = `Solo ${Date.now()}`;

		// Owner joins the seeded shared workspace and creates a workspace-shared
		// dashboard in it, plus a personal one.
		const pOwner = await ctxOwner.newPage();
		const ownerId = await signUpWithId(pOwner, uniqueEmail("d4-owner"));
		await joinShared(ownerId, "owner");
		await pOwner.reload();
		await waitWorkspaceReady(pOwner);
		await expect(
			pOwner.getByRole("button", { name: "Household", exact: true }),
		).toBeVisible({ timeout: 15000 });
		await createDashboard(pOwner, teamDash, { workspace: "Household" });
		await createDashboard(pOwner, soloDash);

		// A second member sees the workspace dashboard, never the personal one.
		const pMember = await ctxMember.newPage();
		const memberId = await signUpWithId(pMember, uniqueEmail("d4-member"));
		await joinShared(memberId, "member");
		await pMember.reload();
		await waitWorkspaceReady(pMember);
		await expect(
			sidebarLists(pMember).getByRole("button", {
				name: teamDash,
				exact: true,
			}),
		).toBeVisible({ timeout: 15000 });
		await expect(
			sidebarLists(pMember).getByRole("button", {
				name: soloDash,
				exact: true,
			}),
		).toHaveCount(0);

		// A non-member never sees it (dashboards section is rendered, entry absent).
		const pOutsider = await ctxOutsider.newPage();
		await signUp(pOutsider, uniqueEmail("d4-outsider"));
		await waitWorkspaceReady(pOutsider);
		await expect(pOutsider.getByTestId("new-dashboard")).toBeVisible();
		await expect(
			sidebarLists(pOutsider).getByRole("button", {
				name: teamDash,
				exact: true,
			}),
		).toHaveCount(0);

		// A viewer sees and opens the dashboard but gets no edit affordances.
		const pViewer = await ctxViewer.newPage();
		const viewerId = await signUpWithId(pViewer, uniqueEmail("d4-viewer"));
		await joinShared(viewerId, "viewer");
		await pViewer.reload();
		await waitWorkspaceReady(pViewer);
		await openDashboardFromSidebar(pViewer, teamDash);
		await expect(
			pViewer.getByRole("heading", { name: teamDash, level: 1 }),
		).toBeVisible();
		await expect(pViewer.getByTestId("dashboard-empty")).toBeVisible();
		await expect(pViewer.getByTestId("dashboard-edit")).toHaveCount(0);
		await expect(pViewer.getByTestId("dashboard-empty-add")).toHaveCount(0);
	} finally {
		await ctxOwner.close();
		await ctxMember.close();
		await ctxOutsider.close();
		await ctxViewer.close();
	}
});

// --- Scenario 5: streak + focus panels over seeded habit logs and sessions ---
test("dashboard panels: streak shows seeded streak/adherence, focus shows count/minutes", async ({
	page,
}) => {
	const email = uniqueEmail("d5");
	const HABIT = "Morning stretch";
	await signUp(page, email);
	await waitWorkspaceReady(page);

	// Seed a habit (daily, done today + yesterday) and two 10-min work sessions;
	// reload so the client syncs them before the panels are built.
	await seedHabitAndFocus(email, HABIT, await browserToday(page));
	await page.reload();
	await waitWorkspaceReady(page);

	const dashName = `Habits board ${Date.now()}`;
	await createDashboard(page, dashName);

	// Streak panel over the seeded habit.
	await page.getByTestId("dashboard-empty-add").click();
	await page.getByTestId("panel-type-streak").click();
	await page.getByRole("checkbox", { name: HABIT }).click();
	await page.getByTestId("panel-save").click();
	await expectPanelDialogClosed(page);
	const streakRow = page.getByTestId("streak-row");
	await expect(streakRow).toBeVisible({ timeout: 15000 });
	await expect(streakRow).toHaveAttribute(
		"aria-label",
		/2 day streak, \d+% on track/,
	);
	await expect(streakRow.getByText(HABIT, { exact: true })).toBeVisible();

	// Focus panel (range: today) over the seeded sessions.
	await page.getByTestId("add-panel").click();
	await page.getByTestId("panel-type-focus").click();
	await expect(page.getByTestId("panel-range-today")).toBeChecked();
	await page.getByTestId("panel-save").click();
	await expectPanelDialogClosed(page);
	const focusPanel = page.getByTestId("focus-panel");
	await expect(focusPanel).toBeVisible({ timeout: 15000 });
	// Count + unit render as one paragraph ("2focus sessions").
	await expect(focusPanel.getByText(/^2\s*focus sessions$/)).toBeVisible();
	await expect(focusPanel.getByTestId("focus-minutes")).toHaveText(
		"20 min focused",
		{ timeout: 15000 },
	);
});

// --- Scenario 6: g d, palette entry, set-as-home round-trip, delete fallback ---
test("dashboard nav: g d and palette open it, home ref survives reload, delete falls back to Today", async ({
	page,
}) => {
	// user_pref is keyed by user id; scope the sync barriers to this user so a
	// stale row from a prior in-test retry can't skew the unfiltered count.
	const userId = await signUpWithId(page, uniqueEmail("d6"));
	await waitWorkspaceReady(page);

	const dashName = `Homey ${Date.now()}`;
	await createDashboard(page, dashName);

	// Move to Today, then g d navigates to the first dashboard.
	await blur(page);
	await page.keyboard.press("g");
	await page.keyboard.press("t");
	await expect(
		page.getByRole("heading", { name: "Today", level: 1 }),
	).toBeVisible({ timeout: 15000 });
	await blur(page);
	await page.keyboard.press("g");
	await page.keyboard.press("d");
	await expect(
		page.getByRole("heading", { name: dashName, level: 1 }),
	).toBeVisible({ timeout: 15000 });

	// Back to Today; the palette "Dashboard: <name>" entry navigates too.
	await blur(page);
	await page.keyboard.press("g");
	await page.keyboard.press("t");
	await expect(
		page.getByRole("heading", { name: "Today", level: 1 }),
	).toBeVisible({ timeout: 15000 });
	await page.keyboard.press("ControlOrMeta+k");
	const palette = page.getByRole("combobox", {
		name: "Command palette search",
	});
	await expect(palette).toBeVisible();
	await palette.fill(dashName);
	await expect(
		page.getByRole("option", { name: `Dashboard: ${dashName}` }),
	).toBeVisible({ timeout: 15000 });
	await page.keyboard.press("Enter");
	await expect(
		page.getByRole("heading", { name: dashName, level: 1 }),
	).toBeVisible({ timeout: 15000 });
	// Palette teardown before further interaction (views.spec flake guard).
	await expect(palette).toBeHidden({ timeout: 15000 });

	// Set as home; the reopened menu reflects the checked state (also gives the
	// pref write time to sync), then a reload lands on the dashboard.
	await page.getByTestId("dashboard-actions").click();
	await page.getByTestId("dashboard-set-home").click();
	// Wait for the menu teardown before re-opening, else the trigger click races
	// the closing menu and gets swallowed (Radix pointer-events race).
	await expect(page.getByTestId("dashboard-set-home")).toBeHidden({
		timeout: 15000,
	});
	await page.getByTestId("dashboard-actions").click();
	await expect(page.getByTestId("dashboard-set-home")).toBeVisible({
		timeout: 15000,
	});
	await expect(page.getByTestId("dashboard-set-home")).toHaveAttribute(
		"aria-checked",
		"true",
		{ timeout: 15000 },
	);
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("dashboard-set-home")).toBeHidden();
	// Sync barrier: reload only once the pref write reached the server (a reload
	// that races the in-flight push is a Zero durability concern, not the
	// home-ref behavior under test).
	await expectServerState(
		async (pool) =>
			(
				await pool.query(
					`select count(*)::int as c from user_pref
					 where id = $1 and home_view_ref is not null`,
					[userId],
				)
			).rows[0].c,
		1,
	);
	await page.reload();
	await waitWorkspaceReady(page);
	await expect(
		page.getByRole("heading", { name: dashName, level: 1 }),
	).toBeVisible({ timeout: 15000 });

	// Delete the home dashboard (confirm accepted) -> falls back to Today, and
	// the fallback survives a reload (home ref was cleared, not left dangling).
	page.once("dialog", (dialog) => void dialog.accept());
	await page.getByTestId("dashboard-actions").click();
	await page.getByTestId("dashboard-delete").click();
	await expect(
		page.getByRole("heading", { name: "Today", level: 1 }),
	).toBeVisible({ timeout: 15000 });
	// Sync barrier: delete + pref clear reached the server before the reload.
	await expectServerState(async (pool) => {
		const d = await pool.query(
			`select count(*)::int as c from dashboard where name = $1`,
			[dashName],
		);
		const p = await pool.query(
			`select count(*)::int as c from user_pref
			 where id = $1 and home_view_ref is not null`,
			[userId],
		);
		return d.rows[0].c + p.rows[0].c;
	}, 0);
	await page.reload();
	await waitWorkspaceReady(page);
	await expect(
		page.getByRole("heading", { name: "Today", level: 1 }),
	).toBeVisible({ timeout: 15000 });
	await expect(
		sidebarLists(page).getByRole("button", { name: dashName, exact: true }),
	).toHaveCount(0);
});

// --- Scenario 7: axe merge gate on the dashboard surfaces ---
test("a11y: no serious/critical violations on dashboard view, edit mode, add-panel dialog", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await signUp(page, uniqueEmail("axe-dash"));
	await waitWorkspaceReady(page);

	await createListDesktop(page, "AxeDash");
	await openListDesktop(page, "AxeDash");
	await addTask(page, "Axe dash item");

	const dashName = `Axe board ${Date.now()}`;
	await createDashboard(page, dashName);

	// Populate: inline tasks panel + inline counter + focus panel.
	await page.getByTestId("dashboard-empty-add").click();
	await page.getByTestId("panel-type-tasks").click();
	await pickSelect(
		page,
		page.getByTestId("panel-source-mode"),
		"Custom filter",
	);
	await page.getByTestId("panel-save").click();
	await expectPanelDialogClosed(page);
	await page.getByTestId("add-panel").click();
	await page.getByTestId("panel-type-counter").click();
	await pickSelect(
		page,
		page.getByTestId("panel-source-mode"),
		"Custom filter",
	);
	await page.getByTestId("panel-save").click();
	await expectPanelDialogClosed(page);
	await addFocusPanel(page, page.getByTestId("add-panel"), "Focus check");

	// Populated view mode.
	await page.getByTestId("dashboard-edit").click();
	await expect(page.getByTestId("dashboard-edit")).toHaveText("Edit");
	await expect(
		page.getByTestId("tasks-panel").getByText("Axe dash item", { exact: true }),
	).toBeVisible({ timeout: 15000 });
	await expectNoSeriousA11y(page, "dashboard view");

	// Edit mode active (drag handles + panel menus + ghost tile).
	await page.getByTestId("dashboard-edit").click();
	await expect(page.getByTestId("dashboard-edit")).toHaveText("Done");
	await expect(page.getByTestId("add-panel")).toBeVisible();
	await expectNoSeriousA11y(page, "dashboard edit mode");

	// AddPanelDialog open (type step).
	await page.getByTestId("add-panel").click();
	await expect(page.getByTestId("panel-type-tasks")).toBeVisible();
	await expectNoSeriousA11y(page, "add panel dialog");
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("panel-type-tasks")).toBeHidden({
		timeout: 15000,
	});
});
