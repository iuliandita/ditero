import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { Pool } from "pg";

// #355: board cards, calendar chips and dashboard task panels carry the same
// cues a list row does, a board saved with the form's default grouping still
// groups, and sticky/floating bars and dashboard slots stay calm (no blur, no
// dashed outlines). Conventions mirror views.spec: signup, Pool seed by email,
// frozen-frame axe.
test.describe.configure({ retries: 2, timeout: 90_000 });

const PASSWORD = "pw-123456";
const SIGNUP_TIMEOUT = 30_000;
const LONG_TITLE =
	"Replace the hallway light bulb and check the fuse box while the power is off";

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

async function blur(page: Page): Promise<void> {
	await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

type SeedTask = {
	list: "home" | "shop";
	title: string;
	priority: number;
	done?: boolean;
	// Days from now, all-day. Omitted: undated.
	dueInDays?: number;
	// Due at UTC noon today (timed), the calendar spec's in-grid anchor.
	dueToday?: boolean;
};

// Two lists of different kinds so every surface spans lists, then the tasks.
async function seed(email: string, tasks: SeedTask[]): Promise<void> {
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
		const lists = { home: crypto.randomUUID(), shop: crypto.randomUUID() };
		await pool.query(
			`insert into list (id, workspace_id, owner_id, title, kind, sort_key)
			 values ($1, $3, $4, 'Home jobs', 'tasks', 'a0'),
			        ($2, $3, $4, 'Groceries', 'shopping', 'a1')`,
			[lists.home, lists.shop, row.wsId, row.ownerId],
		);
		let i = 0;
		for (const t of tasks) {
			i += 1;
			const due = t.dueToday
				? "date_trunc('day', now() at time zone 'utc') + interval '12 hours'"
				: t.dueInDays != null
					? `now() + interval '${t.dueInDays} days'`
					: "null";
			await pool.query(
				`insert into task (id, list_id, title, sort_key, due_at, due_all_day, done, priority)
				 values ($1, $2, $3, $4, ${due}, $5, $6, $7)`,
				[
					crypto.randomUUID(),
					lists[t.list],
					t.title,
					`a${String(i).padStart(2, "0")}`,
					!t.dueToday,
					t.done ?? false,
					t.priority,
				],
			);
		}
	} finally {
		await pool.end();
	}
}

const BOARD_TASKS: SeedTask[] = [
	{ list: "home", title: LONG_TITLE, priority: 3, dueInDays: 3 },
	{ list: "home", title: "Pay rent", priority: 3, done: true },
	{ list: "home", title: "Book dentist", priority: 2 },
	{ list: "home", title: "Water plants", priority: 0 },
	{ list: "shop", title: "Oat milk", priority: 1 },
];

// A view built the way the review built "By priority": name + Board layout,
// grouping left alone.
async function createBoardView(page: Page, name: string): Promise<void> {
	await page.getByTestId("sidebar-create").click();
	await page.getByTestId("new-view").click();
	await page.getByTestId("view-name").fill(name);
	await pickSelect(page, page.getByLabel("Layout", { exact: true }), "Board");
	await page.getByTestId("view-save").click();
	await expect(page.getByTestId("view-surface")).toBeVisible({
		timeout: 15000,
	});
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
			JSON.stringify(serious.map((v) => ({ id: v.id, nodes: v.nodes.length }))),
		);
	expect(serious, `serious/critical a11y violations on ${surface}`).toEqual([]);
}

// Bordered boxes in the card and any inner fill that differs from the card's
// own: a nested card shows up as a second border or a second surface colour.
async function surfaceReport(
	card: Locator,
): Promise<{ bordered: number; innerFills: number }> {
	return card.evaluate((root) => {
		const visible = (el: Element) => {
			const s = getComputedStyle(el);
			return parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== "none";
		};
		const divs = [root, ...root.querySelectorAll("div")];
		const bordered = divs.filter(visible);
		const surface = bordered[0];
		if (!surface) return { bordered: 0, innerFills: 0 };
		const own = getComputedStyle(surface).backgroundColor;
		const innerFills = [...surface.querySelectorAll("div")].filter((d) => {
			const bg = getComputedStyle(d).backgroundColor;
			return bg !== "rgba(0, 0, 0, 0)" && bg !== own;
		}).length;
		return { bordered: bordered.length, innerFills };
	});
}

async function dashedBorders(root: Locator): Promise<number> {
	return root.evaluate(
		(el) =>
			[el, ...el.querySelectorAll("*")].filter((n) => {
				const s = getComputedStyle(n);
				return [
					s.borderTopStyle,
					s.borderRightStyle,
					s.borderBottomStyle,
					s.borderLeftStyle,
				].includes("dashed");
			}).length,
	);
}

test("board: default grouping is by priority, cards are one surface with row cues", async ({
	page,
}) => {
	const email = uniqueEmail("vc1");
	await signUp(page, email);
	await seed(email, BOARD_TASKS);
	await page.reload();
	await waitWorkspaceReady(page);

	await createBoardView(page, `By priority ${Date.now()}`);

	// Four priority columns in order, never one untitled "Tasks" column.
	const columns = page.getByTestId("board-column");
	await expect(columns).toHaveCount(4, { timeout: 15000 });
	await expect(columns).toHaveText([
		/^P1 High/,
		/^P2 Medium/,
		/^P3 Low/,
		/^No priority/,
	]);
	await expect(
		page.getByRole("region", { name: "Tasks", exact: true }),
	).toHaveCount(0);
	const high = page.getByRole("region", { name: "P1 High" });
	await expect(
		page.getByRole("region", { name: "P2 Medium" }).getByText("Book dentist"),
	).toBeVisible();
	await expect(
		page.getByRole("region", { name: "P3 Low" }).getByText("Oat milk"),
	).toBeVisible();

	// One card surface: a single border, no inner fill of another colour.
	const card = high.getByTestId("board-card").filter({ hasText: LONG_TITLE });
	await expect(card).toBeVisible();
	await page.mouse.move(0, 0);
	expect(await surfaceReport(card)).toEqual({ bordered: 1, innerFills: 0 });

	// Two-line title, clamped, with the whole title still in the accessible name.
	const title = card.locator("[data-kbd-nav] > span").first();
	const lines = await title.evaluate((el) => {
		const lh = parseFloat(getComputedStyle(el).lineHeight);
		return {
			rendered: Math.round(el.getBoundingClientRect().height / lh),
			clamped: el.scrollHeight > el.clientHeight,
		};
	});
	expect(lines).toEqual({ rendered: 2, clamped: true });
	await expect(card.getByRole("checkbox", { name: LONG_TITLE })).toBeVisible();

	// Row cues: priority flag, due date, and the list (the view spans two).
	await expect(card.getByLabel("Priority: P1 High")).toBeVisible();
	const due = await page.evaluate(() =>
		new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(
			new Date(Date.now() + 3 * 86_400_000),
		),
	);
	await expect(card).toContainText(due);
	await expect(card).toContainText("Home jobs");

	// Completed cards fold per column until asked for.
	await expect(high.getByText("Pay rent", { exact: true })).toHaveCount(0);
	const completed = high.getByTestId("completed-section");
	await expect(completed).toHaveText(/1 item completed/);
	await completed.click();
	await expect(high.getByText("Pay rent", { exact: true })).toBeVisible();

	// Solid sticky header, no frosted glass.
	expect(
		await high
			.getByTestId("board-column-header")
			.evaluate((el) => getComputedStyle(el).backdropFilter),
	).toBe("none");

	// Keyboard: roving j lands on a card's open button.
	await blur(page);
	await page.keyboard.press("j");
	await expect(
		page.getByTestId("board-card").locator("[data-kbd-nav]").first(),
	).toBeFocused();

	await expectNoSeriousA11y(page, "board cards");
});

test("calendar: chips name priority and completion, done chips step back", async ({
	page,
}) => {
	const email = uniqueEmail("vc2");
	await signUp(page, email);
	await seed(email, [
		{ list: "home", title: "Call the plumber", priority: 3, dueToday: true },
		{
			list: "home",
			title: "Take out bins",
			priority: 0,
			done: true,
			dueToday: true,
		},
		{ list: "shop", title: LONG_TITLE, priority: 0, dueToday: true },
	]);
	await page.reload();
	await waitWorkspaceReady(page);

	await page.getByTestId("sidebar-create").click();
	await page.getByTestId("new-view").click();
	await page.getByTestId("view-name").fill(`Month ${Date.now()}`);
	await pickSelect(
		page,
		page.getByLabel("Layout", { exact: true }),
		"Calendar",
	);
	await page.getByTestId("view-save").click();
	await expect(page.getByTestId("calendar-surface")).toBeVisible({
		timeout: 15000,
	});

	const grid = page.getByRole("table");
	await expect(
		grid.getByRole("button", {
			name: "Call the plumber, P1 High",
			exact: true,
		}),
	).toBeVisible({ timeout: 15000 });
	const done = grid.getByRole("button", {
		name: "Take out bins, completed",
		exact: true,
	});
	await expect(done).toBeVisible();
	expect(
		await done
			.locator("span")
			.last()
			.evaluate((el) => getComputedStyle(el).textDecorationLine),
	).toBe("line-through");

	// The long title wraps onto a second line instead of cutting off at once.
	const long = grid.getByRole("button", { name: LONG_TITLE, exact: true });
	const rendered = await long
		.locator("span")
		.last()
		.evaluate((el) =>
			Math.round(
				el.getBoundingClientRect().height /
					parseFloat(getComputedStyle(el).lineHeight),
			),
		);
	expect(rendered).toBe(2);
	await expect(long).toHaveAttribute("title", LONG_TITLE);

	await expectNoSeriousA11y(page, "calendar chips");
});

test("dashboard: a priority board panel sections by priority and hides completed; slots are not dashed", async ({
	page,
}) => {
	const email = uniqueEmail("vc3");
	await signUp(page, email);
	await seed(email, BOARD_TASKS);
	await page.reload();
	await waitWorkspaceReady(page);

	const viewName = `By priority ${Date.now()}`;
	await createBoardView(page, viewName);

	await page.getByTestId("sidebar-create").click();
	await page.getByTestId("new-dashboard").click();
	await page.getByTestId("dashboard-name").fill(`Family ${Date.now()}`);
	await page.getByTestId("dashboard-save").click();
	await expect(page.getByTestId("dashboard-name")).toBeHidden({
		timeout: 15000,
	});

	const empty = page.getByTestId("dashboard-empty");
	await expect(empty.getByTestId("dashboard-empty-add")).toBeVisible();
	expect(await dashedBorders(empty)).toBe(0);

	await empty.getByTestId("dashboard-empty-add").click();
	await page.getByTestId("panel-type-tasks").click();
	await pickSelect(page, page.getByTestId("panel-view-pick"), viewName);
	await page.getByTestId("panel-title").fill("Priority board");
	await page.getByTestId("panel-save").click();
	await expect(page.getByTestId("panel-save")).toBeHidden({ timeout: 15000 });

	const addSlot = page.getByTestId("add-panel");
	await expect(addSlot).toBeVisible();
	expect(await dashedBorders(addSlot)).toBe(0);

	const panel = page.getByTestId("tasks-panel");
	const high = panel.getByRole("region", { name: "P1 High" });
	await expect(high.getByText(LONG_TITLE, { exact: true })).toBeVisible({
		timeout: 15000,
	});
	await expect(
		panel.getByRole("region", { name: "P2 Medium" }).getByText("Book dentist"),
	).toBeVisible();
	await expect(panel.getByTestId("panel-priority-section")).toHaveCount(4);
	await expect(panel.getByText("Pay rent", { exact: true })).toHaveCount(0);
	// Same row cues as a list: priority flag and the list the row lives in.
	await expect(high.getByLabel("Priority: P1 High")).toBeVisible();
	// Rows sit directly on the panel's surface, not on a box of canvas colour.
	await page.getByTestId("dashboard-edit").click();
	await page.mouse.move(0, 0);
	const frame = page.getByRole("region", { name: "Priority board" });
	expect((await surfaceReport(frame)).innerFills).toBe(0);
	await expect(
		panel.getByRole("region", { name: "P3 Low" }).getByText("Groceries"),
	).toBeVisible();
});

test("mobile: the bottom nav is a solid bar", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await signUp(page, uniqueEmail("vc4"));
	const nav = page.getByRole("navigation", { name: "Primary" });
	await expect(nav).toBeVisible({ timeout: 15000 });
	expect(await nav.evaluate((el) => getComputedStyle(el).backdropFilter)).toBe(
		"none",
	);
});
