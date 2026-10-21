import { expect, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import {
	goToSettings,
	leaveSettings,
	openDetails,
	openMoreOptions,
	signUp,
	uniqueEmail,
} from "./helpers.ts";

test.describe.configure({ timeout: 90000 });
async function startTask(page: Page, seconds: number) {
	await page.addInitScript((sec) => {
		(window as { __diteroFocusTestSec?: number }).__diteroFocusTestSec = sec;
	}, seconds);
	const userId = await signUp(page, uniqueEmail("persist-focus"));
	await goToSettings(page);
	await page.getByTestId("focus-autocycle").click();
	await expect(page.getByTestId("focus-autocycle")).toHaveAttribute(
		"aria-checked",
		"false",
	);
	await leaveSettings(page);
	await page.getByTestId("create-list-open").click();
	await page.getByTestId("new-list").fill("Timer tasks");
	await page.getByTestId("new-list-submit").click();
	await page
		.locator('nav[aria-label="Lists"]')
		.getByRole("button", { name: "Timer tasks", exact: true })
		.click();
	await page.getByTestId("new-task").fill("Read together");
	await page.getByTestId("new-task-submit").click();
	await openDetails(page, "Read together");
	const detail = page.getByRole("dialog");
	await openMoreOptions(detail);
	await detail.getByTestId("task-focus-start").click();
	await detail.getByRole("button", { name: "Close", exact: true }).click();
	await expect(detail).toHaveCount(0);
	return userId;
}

test("running and paused task timers survive reload; Stop discards them", async ({
	page,
}) => {
	await startTask(page, 120);
	const timer = page.getByTestId("focus-timer");
	await expect(timer.getByTestId("focus-pause")).toBeVisible();
	await page.reload();
	await expect(timer.getByTestId("focus-task")).toHaveText("Read together");
	await expect(timer.getByTestId("focus-pause")).toBeVisible();
	await timer.getByTestId("focus-pause").click();
	const paused = await timer.getByTestId("focus-countdown").textContent();
	await page.reload();
	await expect(timer.getByTestId("focus-start")).toBeVisible();
	await expect(timer.getByTestId("focus-countdown")).toHaveText(paused ?? "");
	await timer.getByTestId("focus-start").click();
	await expect(timer.getByTestId("focus-pause")).toBeVisible();
	await timer.getByTestId("focus-stop").click();
	await page.reload();
	await expect(page.getByTestId("workspace")).toBeVisible();
	await expect(timer).toHaveCount(0);
});

test("an interval that expires away records once and parks on the next phase", async ({
	page,
}) => {
	const userId = await startTask(page, 5);
	const origin = page.url();
	await page.goto("about:blank");
	await page.waitForTimeout(6000);
	await page.goto(origin);
	const timer = page.getByTestId("focus-timer");
	await expect(timer.getByTestId("focus-phase")).toHaveText("Break");
	await expect(timer.getByTestId("focus-start")).toBeVisible();
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await expect
			.poll(
				async () =>
					(
						await pool.query(
							"select duration_sec from focus_session where user_id=$1 and task_id is not null",
							[userId],
						)
					).rows,
			)
			.toEqual([{ duration_sec: 5 }]);
		await page.reload();
		await expect(timer.getByTestId("focus-phase")).toHaveText("Break");
		expect(
			(
				await pool.query(
					"select count(*)::int as count from focus_session where user_id=$1",
					[userId],
				)
			).rows,
		).toEqual([{ count: 1 }]);
	} finally {
		await pool.end();
	}
});
