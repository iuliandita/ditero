import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { Pool } from "pg";

// M2 calendar-layout e2e. Builds a calendar view, asserts a recurring task's
// occurrences render on many dates (light chips) and a one-off dued task renders
// on its day, reschedules the one-off by drag (dueAt updates, confirmed after a
// reopen), and asserts the < md agenda collapse. Axe on month + agenda + mobile.
// Conventions (signUp/uniqueEmail/Pool seed/frozen-frame axe) mirror views.spec.
test.describe.configure({ retries: 2, timeout: 90_000 });

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

async function waitWorkspaceReady(page: Page): Promise<void> {
	await expect(page.getByRole("button", { name: /'s space/ })).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
}

async function pickSelect(
	page: Page,
	trigger: Locator,
	option: string,
): Promise<void> {
	await trigger.click();
	await page.getByRole("option", { name: option, exact: true }).click();
}

async function pickLabeled(
	page: Page,
	label: string,
	option: string,
): Promise<void> {
	await pickSelect(page, page.getByLabel(label, { exact: true }), option);
}

// Seed a list plus tasks straight into the user's personal workspace (resolve
// user + workspace by email, no session fetch), the way views.spec seeds. One
// one-off task dued at UTC-noon today, and one daily-recurring task (rrule), so
// the calendar has both a concrete draggable chip and expanded occurrences.
async function seedCalendarFixture(
	email: string,
	oneOff: string,
	recurring: string,
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
			 values ($1, $2, $3, 'Calendar list', 'tasks', 'a0')`,
			[listId, row.wsId, row.ownerId],
		);
		// due_at at UTC-noon today so a within-month reschedule stays in the grid.
		await pool.query(
			`insert into task (id, list_id, title, sort_key, due_at, due_all_day, done, priority)
			 values ($1, $2, $3, 'a0', date_trunc('day', now() at time zone 'utc') + interval '12 hours', false, false, 0)`,
			[crypto.randomUUID(), listId, oneOff],
		);
		// Daily recurrence: expands onto every visible day of the month grid.
		await pool.query(
			`insert into task (id, list_id, title, sort_key, rrule, done, priority)
			 values ($1, $2, $3, 'a1', 'FREQ=DAILY;INTERVAL=1', false, 0)`,
			[crypto.randomUUID(), listId, recurring],
		);
	} finally {
		await pool.end();
	}
}

// Read a task's due date as a UTC "YYYY-MM-DD" string, by title, to confirm a
// drag actually moved dueAt (not just that a chip still renders).
async function readDueDateUTC(title: string): Promise<string | null> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		const rows = await pool.query<{ d: string | null }>(
			`select to_char(due_at at time zone 'utc', 'YYYY-MM-DD') as d
			 from task where title = $1`,
			[title],
		);
		return rows.rows[0]?.d ?? null;
	} finally {
		await pool.end();
	}
}

async function expectNoSeriousA11y(page: Page, surface: string): Promise<void> {
	await page.addStyleTag({
		content:
			"*,*::before,*::after{animation:none!important;transition:none!important}",
	});
	const { violations } = await new AxeBuilder({ page }).analyze();
	const serious = violations.filter(
		(v) => v.impact === "serious" || v.impact === "critical",
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

async function saveCalendarView(page: Page, name: string): Promise<void> {
	await page.getByTestId("new-view").click();
	await page.getByTestId("view-name").fill(name);
	await pickLabeled(page, "Layout", "Calendar");
	await page.getByTestId("view-save").click();
}

// --- Desktop: occurrences render on many days, one-off on its day, drag reschedules ---
test("calendar: occurrences span the month, one-off reschedules by drag", async ({
	page,
}) => {
	const email = uniqueEmail("cal");
	await signUp(page, email);
	await waitWorkspaceReady(page);

	const oneOff = `OneOff ${Date.now()}`;
	const recurring = `Daily ${Date.now()}`;
	await seedCalendarFixture(email, oneOff, recurring);
	await page.reload();
	await waitWorkspaceReady(page);

	await saveCalendarView(page, `Cal ${Date.now()}`);
	await expect(page.getByTestId("calendar-surface")).toBeVisible({
		timeout: 15000,
	});

	// Scope to month-grid chips (calendar-chip); the agenda repeats titles too.
	const monthChips = page.getByTestId("calendar-chip");
	// The daily-recurring task expands onto every visible day: its chip appears
	// far more than once across the grid cells.
	const occChips = monthChips.filter({ hasText: recurring });
	await expect(occChips.first()).toBeVisible({ timeout: 15000 });
	expect(await occChips.count()).toBeGreaterThan(20);

	// The one-off dued task renders as a single concrete chip on today's cell.
	const oneOffChip = monthChips.filter({ hasText: oneOff });
	await expect(oneOffChip).toHaveCount(1);

	// Drag the one-off chip onto a different day cell (a recurring occurrence's
	// cell is a convenient, always-present target). dnd-kit needs intermediate
	// pointer steps to clear the 6px activation distance.
	const source = await oneOffChip.boundingBox();
	// Pick an occurrence chip whose cell differs from today; the last one in the
	// grid is late in the month, guaranteed off today's cell.
	const targetChip = occChips.last();
	const target = await targetChip.boundingBox();
	if (!source || !target) throw new Error("missing drag targets");
	await page.mouse.move(
		source.x + source.width / 2,
		source.y + source.height / 2,
	);
	await page.mouse.down();
	await page.mouse.move(
		source.x + source.width / 2,
		source.y + source.height / 2 + 10,
		{ steps: 6 },
	);
	await page.mouse.move(
		target.x + target.width / 2,
		target.y + target.height / 2,
		{ steps: 20 },
	);
	await page.mouse.move(
		target.x + target.width / 2,
		target.y + target.height / 2 + 3,
		{ steps: 5 },
	);
	await page.mouse.up();

	// dueAt actually moved off today's date (drag wrote a new due_at, not a no-op).
	const todayUTC = new Date().toISOString().slice(0, 10);
	await expect
		.poll(() => readDueDateUTC(oneOff), { timeout: 15000 })
		.not.toBe(todayUTC);

	// The reschedule persists: reload, reopen the view, the one-off chip is still
	// present exactly once (dueAt moved within the month, not dropped).
	await page.reload();
	await waitWorkspaceReady(page);
	await page
		.getByRole("navigation", { name: "Lists" })
		.getByRole("button", { name: /^Cal / })
		.first()
		.click();
	await expect(page.getByTestId("calendar-surface")).toBeVisible({
		timeout: 15000,
	});
	await expect(
		page.getByTestId("calendar-chip").filter({ hasText: oneOff }),
	).toHaveCount(1);

	// Axe the month grid + agenda.
	await expectNoSeriousA11y(page, "calendar month + agenda");
});

// --- Mobile: the calendar collapses to a date-grouped agenda ---
test("calendar: < md collapses to the agenda affordance", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const email = uniqueEmail("cal-m");
	await signUp(page, email);
	await waitWorkspaceReady(page);

	const oneOff = `MobileDue ${Date.now()}`;
	const recurring = `MobileDaily ${Date.now()}`;
	await seedCalendarFixture(email, oneOff, recurring);
	await page.reload();
	await waitWorkspaceReady(page);

	await saveCalendarView(page, `MobCal ${Date.now()}`);

	// The month grid is gone; the agenda affordance is shown and the dated item
	// renders in the agenda list.
	await expect(page.getByTestId("calendar-surface")).toBeVisible({
		timeout: 15000,
	});
	await expect(page.getByText("Viewing as agenda")).toBeVisible({
		timeout: 15000,
	});
	await expect(page.getByTestId("calendar-agenda")).toBeVisible();
	await expect(
		page.getByTestId("agenda-item").filter({ hasText: oneOff }),
	).toHaveCount(1);

	await expectNoSeriousA11y(page, "calendar agenda (mobile)");
});
