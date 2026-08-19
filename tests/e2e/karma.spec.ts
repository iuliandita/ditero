import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { goToSettings } from "./helpers.ts";

// M2 Karma display e2e (Task 12). Seeds karma by completing a task, opens the
// own-user Progress panel and asserts the level ring + points + a ledger entry,
// sets a daily goal and sees the goal ring reflect it, toggles vacation and sees
// the note. Plus the axe merge gate on the settings surface. Conventions
// (signUp/uniqueEmail/testid locators/frozen-frame axe) mirror habits.spec.
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

function workspaceButton(page: Page): Locator {
	return page.getByRole("button", { name: /'s space/ });
}

async function waitWorkspaceReady(page: Page): Promise<void> {
	await expect(workspaceButton(page)).toBeVisible({ timeout: SIGNUP_TIMEOUT });
}

async function openListDesktop(page: Page, name: string): Promise<void> {
	await sidebarLists(page)
		.getByRole("button", { name, exact: true })
		.last()
		.click();
	await expect(page.getByTestId("list")).toBeVisible();
}

async function createListDesktop(page: Page, name: string): Promise<void> {
	await waitWorkspaceReady(page);
	await page.getByTestId("new-list").fill(name);
	await page.getByTestId("new-list-submit").click();
	await expect(
		sidebarLists(page).getByRole("button", { name, exact: true }).first(),
	).toBeVisible({ timeout: 15000 });
}

async function addTask(page: Page, title: string): Promise<void> {
	await page.getByTestId("new-task").fill(title);
	await page.getByTestId("new-task-submit").click();
	await expect(
		page.getByTestId("list").getByText(title, { exact: true }),
	).toBeVisible({ timeout: 15000 });
}

// Create a Habits list from the starter template (habits kind is not in the
// blank-list picker; the starter is the create path) -- mirrors habits.spec.
async function createHabitsList(page: Page): Promise<void> {
	await waitWorkspaceReady(page);
	await page.getByRole("combobox", { name: "Start from template" }).click();
	await page.getByRole("option", { name: "Habits", exact: true }).click();
	await page.getByTestId("new-list-submit").click();
	await expect(
		sidebarLists(page)
			.getByRole("button", { name: "Habits", exact: true })
			.first(),
	).toBeVisible({ timeout: 15000 });
}

// Gate per design 2.14: zero serious/critical violations. Freeze animations so
// axe samples the settled frame (matches habits.spec exactly).
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

test("karma: complete a habit, Progress panel shows level + points + ledger; set goal; vacation", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("karma"));
	await createHabitsList(page);
	await openListDesktop(page, "Habits");

	// Complete the first seeded habit -> habit.log awards karma (+3, habit_done).
	const card = page.getByTestId("habit-card").first();
	await expect(card).toBeVisible();
	await card.getByTestId("habit-done").click();
	await expect(card.getByTestId("habit-done")).toHaveAttribute(
		"aria-pressed",
		"true",
		{ timeout: 15000 },
	);

	// The Progress panel lives on the settings surface.
	await goToSettings(page);
	const panel = page.getByTestId("karma-panel");
	await expect(panel).toBeVisible();

	// Ledger: the completion is line-itemized as a +3 gain (confirms karma synced).
	const row = page.getByTestId("karma-ledger-row").filter({
		hasText: "Habit done",
	});
	await expect(row).toBeVisible({ timeout: 15000 });
	await expect(row.getByTestId("karma-ledger-delta")).toHaveText("+3");

	// Level ring: level 1, 3 points (3 < 50 = first threshold).
	await expect(panel.getByRole("img", { name: /^Level 1,/ })).toBeVisible();
	await expect(panel.getByText("3 pts")).toBeVisible({ timeout: 15000 });

	// Set a daily goal of 1 -> the daily ring reflects it and reads as met
	// (one completion today).
	await page.getByTestId("karma-goal-daily-input").fill("1");
	await expect(
		page
			.getByTestId("karma-goal-daily")
			.getByRole("img", { name: "Daily goal 1 of 1, met" }),
	).toBeVisible({ timeout: 15000 });

	// Toggle vacation -> switch checked, badge + honesty note appear.
	await page.getByTestId("karma-vacation-toggle").click();
	await expect(page.getByTestId("karma-vacation-toggle")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect(page.getByTestId("karma-vacation-note")).toBeVisible();

	// Axe the settings surface while populated.
	await expectNoSeriousA11y(page, "karma panel + settings");
});

// Part A proof: completing a regular (non-recurring) task through the list
// checkbox routes to task.complete, which awards Karma (task_complete, +5 at
// default priority). Proves the checkbox is wired to the awarding path.
test("karma: completing a regular task via the list checkbox awards Karma", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("karma-task"));
	await waitWorkspaceReady(page);

	await createListDesktop(page, "Errands");
	await openListDesktop(page, "Errands");
	await addTask(page, "Buy milk");

	const list = page.getByTestId("list");
	const checkbox = list.getByRole("checkbox", { name: "Buy milk" });
	await checkbox.click();
	await expect(checkbox).toHaveAttribute("aria-checked", "true", {
		timeout: 15000,
	});

	await goToSettings(page);
	await expect(page.getByTestId("karma-panel")).toBeVisible();

	// Ledger line-items the task completion as a +5 gain (base task, priority 0).
	const row = page
		.getByTestId("karma-ledger-row")
		.filter({ hasText: "Completed a task" });
	await expect(row).toBeVisible({ timeout: 15000 });
	await expect(row.getByTestId("karma-ledger-delta")).toHaveText("+5");
	await expect(page.getByTestId("karma-panel").getByText("5 pts")).toBeVisible({
		timeout: 15000,
	});
});
