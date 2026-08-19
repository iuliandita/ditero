import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { goToSettings, leaveSettings } from "./helpers.ts";

// M2 focus/Pomodoro timer e2e. Configures the focus prefs (round-trips), starts a
// task-bound focus session, and (via the dev-only time seam) lets the work interval
// complete in seconds -- verifying a focus_session is logged (time-on-task updates),
// the end-of-interval cue fires, and the timer advances. Plus the axe gate on the
// pill + settings. Conventions mirror habits.spec.
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
	return detail;
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

test.beforeEach(async ({ page }) => {
	// Dev-only time seam: each focus interval lasts 2s instead of its configured
	// minutes, so the work interval completes within the test without faking the
	// page clock (which Zero's sync loop rides on).
	await page.addInitScript(() => {
		(window as { __diteroFocusTestSec?: number }).__diteroFocusTestSec = 2;
	});
});

test("focus: settings round-trip, task-bound session logs + advances, axe", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("focus"));
	await waitWorkspaceReady(page);

	// --- Settings: edit focus config, turn auto-cycle off, verify round-trip. ---
	// Auto-cycle off so exactly one work interval logs (no follow-on work session
	// racing the time-on-task assertion).
	await goToSettings(page);
	await expect(page.getByTestId("focus-autocycle")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await page.getByTestId("focus-autocycle").click();
	await expect(page.getByTestId("focus-autocycle")).toHaveAttribute(
		"aria-checked",
		"false",
	);
	await page.getByTestId("focus-work-min").fill("30");
	await page.getByTestId("focus-work-min").blur();

	await expectNoSeriousA11y(page, "focus settings");

	// Round-trip across a reload (pref is synced, not local).
	await page.reload();
	await waitWorkspaceReady(page);
	await goToSettings(page);
	await expect(page.getByTestId("focus-work-min")).toHaveValue("30");
	await expect(page.getByTestId("focus-autocycle")).toHaveAttribute(
		"aria-checked",
		"false",
	);

	// --- Start a task-bound focus session. ---
	await leaveSettings(page);
	await createListDesktop(page, "Deep work");
	await openListDesktop(page, "Deep work");
	await addTask(page, "Write report");

	let detail = await openDetail(page, "Write report");
	await expect(detail.getByTestId("task-time-on-task")).toHaveText(
		"No focus time yet",
	);
	await detail.getByTestId("task-focus-start").click();
	// Close the detail: it is a modal Sheet, which makes the app-level pill inert
	// while open. The session is app-scoped and survives the close.
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toBeHidden({ timeout: 15000 });

	// The docked pill appears, bound to the task, in the Focus phase.
	const pill = page.getByTestId("focus-timer");
	await expect(pill).toBeVisible();
	await expect(pill.getByTestId("focus-phase")).toHaveText("Focus");
	await expect(pill.getByTestId("focus-task")).toHaveText("Write report");

	// After the 2s work interval completes: cue fires and (auto-cycle off) the
	// timer parks on the Break phase.
	await expect(pill.getByTestId("focus-phase")).toHaveText("Break", {
		timeout: 15000,
	});
	await expect(pill.getByTestId("focus-cue")).toHaveText("Focus complete");

	// Axe the pill surface while it is docked.
	await expectNoSeriousA11y(page, "focus pill");

	// The finished work interval was logged -> reopening the task shows the
	// time-on-task (2s via the seam).
	detail = await openDetail(page, "Write report");
	await expect(detail.getByTestId("task-time-on-task")).toHaveText(
		"2s focused",
		{ timeout: 15000 },
	);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toBeHidden({ timeout: 15000 });

	// Stop clears the session -> the pill unmounts.
	await pill.getByTestId("focus-stop").click();
	await expect(page.getByTestId("focus-timer")).toHaveCount(0);
});
