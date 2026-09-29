import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { browserToday } from "../support/browser-day.ts";
import { goToSettings, openMoreOptions, setDueDate } from "./helpers.ts";

// M2 recurrence editor e2e. Exercises the preset-driven recurrence control in the
// task detail surface: enable, set a weekly every-2-weeks Mon/Wed rule, verify the
// read-back, toggle fixed<->relative, round-trip across a close/reopen, and clear.
// Plus the axe merge gate on the editor surface. Conventions (signUp/uniqueEmail/
// testid locators/frozen-frame axe) mirror views.spec.
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
	await page.getByTestId("create-list-open").click();
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

async function openDetail(page: Page, title: string): Promise<Locator> {
	await page
		.getByTestId("list")
		.locator("[data-kbd-nav]")
		.filter({ hasText: title })
		.first()
		.click();
	const detail = page.getByRole("dialog");
	await expect(detail.getByLabel("Task title")).toBeVisible();
	// Every caller here works with repeat/focus controls behind the disclosure.
	await openMoreOptions(detail);
	return detail;
}

async function closeDetail(page: Page): Promise<void> {
	// The close button, not Escape: callers may leave focus in a field, where
	// the first Escape only leaves the field.
	await page.getByTestId("task-detail-close").click();
	await expect(page.getByRole("dialog")).toBeHidden({ timeout: 15000 });
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

test("recurrence: set weekly every-2-weeks Mon/Wed, round-trips, toggle relative, clear", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("recur"));
	await waitWorkspaceReady(page);

	await createListDesktop(page, "Recurring");
	await openListDesktop(page, "Recurring");
	await addTask(page, "Water plants");

	let detail = await openDetail(page, "Water plants");

	// Enable recurrence -> the preset editor appears.
	await detail.getByTestId("recurrence-enable").click();
	await expect(detail.getByTestId("recurrence-editor")).toBeVisible();

	// Weekly, every 2, on Mon (seeded) + Wed.
	await detail.getByTestId("recurrence-freq-weekly").click();
	await detail.getByTestId("recurrence-interval").fill("2");
	await expect(detail.getByTestId("recurrence-weekday-0")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await detail.getByTestId("recurrence-weekday-2").click();
	await expect(detail.getByTestId("recurrence-summary")).toHaveText(
		"Every 2 weeks on Mon, Wed",
	);

	// Fixed -> relative.
	await detail.getByTestId("recurrence-relative").click();
	await expect(detail.getByTestId("recurrence-relative")).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	// Axe the editor surface while it is open and populated.
	await expectNoSeriousA11y(page, "recurrence editor");

	// Round-trip: close, reopen, the persisted preset + read-back reappear.
	await closeDetail(page);
	detail = await openDetail(page, "Water plants");
	await expect(detail.getByTestId("recurrence-editor")).toBeVisible();
	await expect(detail.getByTestId("recurrence-freq-weekly")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(detail.getByTestId("recurrence-interval")).toHaveValue("2");
	await expect(detail.getByTestId("recurrence-weekday-0")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(detail.getByTestId("recurrence-weekday-2")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(detail.getByTestId("recurrence-summary")).toHaveText(
		"Every 2 weeks on Mon, Wed",
	);
	await expect(detail.getByTestId("recurrence-relative")).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	// Clear recurrence -> back to "Does not repeat".
	await detail.getByTestId("recurrence-clear").click();
	await expect(detail.getByTestId("recurrence-enable")).toBeVisible();
	await expect(detail.getByTestId("recurrence-editor")).toHaveCount(0);

	// Persisted clear: reopen and the control is off.
	await closeDetail(page);
	detail = await openDetail(page, "Water plants");
	await expect(detail.getByTestId("recurrence-enable")).toBeVisible();
});

// Part A proof: the list checkbox routes a done-transition through task.complete,
// so completing a recurring task advances the occurrence instead of marking it
// done. The row rolls its due date forward and stays pending.
test("recurring task: list checkbox advances the due date and stays pending", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("recur-task"));
	await waitWorkspaceReady(page);

	await createListDesktop(page, "Chores");
	await openListDesktop(page, "Chores");
	await addTask(page, "Take out bins");

	// Due today + a daily recurrence, set through the detail surface. Use the
	// browser-local calendar day so it reads back as "Today" (formatDue compares
	// against local now; a UTC-derived string can be off by a day).
	const detail = await openDetail(page, "Take out bins");
	const today = await browserToday(page);
	await setDueDate(page, detail, today);
	await detail.getByTestId("recurrence-enable").click();
	await expect(detail.getByTestId("recurrence-editor")).toBeVisible();
	await closeDetail(page);

	const list = page.getByTestId("list");
	const row = list
		.locator("[data-kbd-row]")
		.filter({ hasText: "Take out bins" });
	const checkbox = row.getByRole("checkbox", { name: "Take out bins" });
	await expect(row.getByText("Today", { exact: false })).toBeVisible();
	await expect(checkbox).toHaveAttribute("aria-checked", "false");

	// Complete via the list checkbox -> task.complete advances the occurrence.
	await checkbox.click();

	// Pending again (done stayed false) and the due date rolled to tomorrow.
	await expect(checkbox).toHaveAttribute("aria-checked", "false", {
		timeout: 15000,
	});
	await expect(row.getByText("Tomorrow", { exact: false })).toBeVisible({
		timeout: 15000,
	});
});

// L1: the Skip control on a recurring, non-habit task routes to
// task.skipOccurrence -- it advances the due date WITHOUT marking done and
// WITHOUT awarding Karma (the distinguisher from complete, which advances and
// awards). Habits get their own skip on the card, so the detail control is
// gated off there.
test("recurring task: Skip control advances the due date without awarding Karma", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("recur-skip"));
	await waitWorkspaceReady(page);

	await createListDesktop(page, "Skips");
	await openListDesktop(page, "Skips");
	await addTask(page, "Sweep floor");

	// Due today + a daily recurrence so the row reads "Today" and Skip is offered.
	const detail = await openDetail(page, "Sweep floor");
	const today = await browserToday(page);
	await setDueDate(page, detail, today);
	await detail.getByTestId("recurrence-enable").click();
	await expect(detail.getByTestId("recurrence-editor")).toBeVisible();

	// Skip control is present on this recurring, non-habit task.
	const skip = detail.getByTestId("recurrence-skip");
	await expect(skip).toBeVisible();

	// Axe the detail surface with the new Skip markup present.
	await expectNoSeriousA11y(page, "task detail with skip");

	await skip.click();
	await closeDetail(page);

	// Due date rolled to tomorrow and the task stayed pending (not done).
	const list = page.getByTestId("list");
	const row = list.locator("[data-kbd-row]").filter({ hasText: "Sweep floor" });
	const checkbox = row.getByRole("checkbox", { name: "Sweep floor" });
	await expect(row.getByText("Tomorrow", { exact: false })).toBeVisible({
		timeout: 15000,
	});
	await expect(checkbox).toHaveAttribute("aria-checked", "false");

	// No Karma: skip awards nothing, so the Progress ledger stays empty and points
	// stay at 0 (a complete would have line-itemed a +5 gain here).
	await goToSettings(page);
	const panel = page.getByTestId("karma-panel");
	await expect(panel).toBeVisible();
	await expect(page.getByTestId("karma-ledger-empty")).toBeVisible();
	await expect(panel.getByText("0 pts")).toBeVisible();
});

// Create a Habits list from the starter template (habits kind is not in the
// blank-list picker; the starter is the create path).
async function createHabitsList(page: Page): Promise<void> {
	await waitWorkspaceReady(page);
	await page.getByTestId("create-list-open").click();
	await page.getByRole("combobox", { name: "Start from template" }).click();
	await page.getByRole("option", { name: "Habits", exact: true }).click();
	await page.getByTestId("new-list-submit").click();
	await expect(
		sidebarLists(page)
			.getByRole("button", { name: "Habits", exact: true })
			.first(),
	).toBeVisible({ timeout: 15000 });
}

function habitCard(page: Page, title: string): Locator {
	return page.getByTestId("habit-card").filter({ hasText: title });
}

test("habits: track a habit — set recurrence, done/skip/undo, streak + heatmap update", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("habit"));
	await createHabitsList(page);
	await openListDesktop(page, "Habits");

	const HABIT = "Drink water";
	const card = habitCard(page, HABIT);
	await expect(card).toBeVisible();
	// Starter habits carry no RRULE: a one-tap action, not streak math.
	await expect(card.getByTestId("habit-track-daily")).toBeVisible();
	await expect(card.getByTestId("habit-undo")).toHaveCount(0);

	// Set a daily recurrence via the task detail (default preset is daily).
	const detail = await openDetail(page, HABIT);
	await detail.getByTestId("recurrence-enable").click();
	await expect(detail.getByTestId("recurrence-editor")).toBeVisible();
	await closeDetail(page);

	// Tracker now renders; today unlogged -> streak 0, primary not pressed.
	await expect(card.getByTestId("habit-streak")).toHaveText("0 days");
	await expect(card.getByTestId("habit-done")).toHaveAttribute(
		"aria-pressed",
		"false",
	);

	// The heatmap cell is labelled with the user's LOCAL day (localDay), which is
	// what the app both writes and reads -- not this process's UTC day. The label
	// renders that day through Intl in the active locale, so the raw key must not
	// reach the DOM.
	const today = await browserToday(page);
	const [y, mo, d] = today.split("-").map(Number);
	const todayLabel = new Intl.DateTimeFormat("en", {
		month: "short",
		day: "numeric",
	}).format(new Date(y ?? 0, (mo ?? 1) - 1, d ?? 1));
	expect(todayLabel).not.toBe(today);

	// Mark done for today -> streak advances, primary reflects done, heatmap cell.
	await card.getByTestId("habit-done").click();
	await expect(card.getByTestId("habit-streak")).toHaveText("1 day");
	await expect(card.getByTestId("habit-done")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(
		card.getByRole("img", { name: `${todayLabel}: done` }),
	).toBeVisible();

	// Undo -> back to unlogged (streak 0, primary not pressed).
	await card.getByTestId("habit-undo").click();
	await expect(card.getByTestId("habit-streak")).toHaveText("0 days");
	await expect(card.getByTestId("habit-done")).toHaveAttribute(
		"aria-pressed",
		"false",
	);

	// Skip today -> logged skipped (neutral for streak), heatmap cell reflects it.
	await card.getByTestId("habit-skip").click();
	await expect(card.getByTestId("habit-skip")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(
		card.getByRole("img", { name: `${todayLabel}: skipped` }),
	).toBeVisible();

	// Axe the habit list surface.
	await expectNoSeriousA11y(page, "habit list");
});

// The habits surface was shipped in M2 behind a create path that only the starter
// template reached: M1a hid `habits` from the blank-list kind picker while the
// surface did not exist yet, and M2 never unhid it. This drives the picker path.
test("habits: a blank habits list is creatable from the kind picker", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("habit-kind"));
	await waitWorkspaceReady(page);

	await page.getByTestId("create-list-open").click();
	await page.getByTestId("new-list").fill("Chores");
	await page.getByRole("button", { name: "Habits", exact: true }).click();
	await page.getByTestId("new-list-submit").click();

	await expect(
		sidebarLists(page).getByRole("button", { name: "Chores", exact: true }),
	).toBeVisible({ timeout: 15000 });
	await openListDesktop(page, "Chores");

	// Habit mechanics, not task rows: the list renders cards, and a new habit
	// starts daily, so it tracks right away.
	await page.getByTestId("new-task").fill("Walk the dog");
	await page.getByTestId("new-task-submit").click();

	const card = habitCard(page, "Walk the dog");
	await expect(card).toBeVisible({ timeout: 15000 });
	await expect(card.getByTestId("habit-streak")).toHaveText("0 days");
	await expect(card.getByTestId("habit-track-daily")).toHaveCount(0);
});

test("habits: a habit without a recurrence starts tracking in one tap", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("habit-track"));
	await createHabitsList(page);
	await openListDesktop(page, "Habits");

	const card = habitCard(page, "Read");
	const track = card.getByTestId("habit-track-daily");
	await expect(track).toHaveText("Track daily");
	await expect(card.getByTestId("habit-streak")).toHaveCount(0);
	await track.click();
	await expect(card.getByTestId("habit-streak")).toHaveText("0 days");
	await expect(track).toHaveCount(0);
	await expect(card.getByTestId("habit-done")).toBeFocused();
});

// The detail's own done box on a habit logs today's occurrence, the same write
// as the card's Done. task.complete refuses habits, so routing it there would
// raise an error and a false "Completed" snackbar.
test("habits: the detail's done box logs today like the card", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("habit-detail"));
	await createHabitsList(page);
	await openListDesktop(page, "Habits");

	const HABIT = "Drink water";
	const card = habitCard(page, HABIT);
	const detail = await openDetail(page, HABIT);
	await detail.getByTestId("recurrence-enable").click();
	await expect(detail.getByTestId("recurrence-editor")).toBeVisible();
	await expect(card.getByTestId("habit-done")).toHaveAttribute(
		"aria-pressed",
		"false",
	);

	const box = detail.getByTestId("task-detail-done");
	await box.click();
	await expect(card.getByTestId("habit-done")).toHaveAttribute(
		"aria-pressed",
		"true",
		{ timeout: 15000 },
	);
	await expect(box).toBeChecked();
	await expect(detail.getByRole("alert")).toHaveCount(0);
	await expect(page.getByTestId("snackbar")).toHaveCount(0);

	await box.click();
	await expect(card.getByTestId("habit-done")).toHaveAttribute(
		"aria-pressed",
		"false",
		{ timeout: 15000 },
	);
	await expect(box).not.toBeChecked();
});
