import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import {
	goToSettings,
	openMembers,
	openShared,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

test("signup and account settings persist a trimmed display name", async ({
	page,
	browser,
}) => {
	test.setTimeout(90000);
	await page.goto("/");
	await page.getByTestId("signup-mode").click();
	await page.getByTestId("signup-name").fill("  Maya Chen  ");
	const email = uniqueEmail("display-name");
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill("pw-123456");
	await page.getByTestId("signup").click();
	await expect(page.getByRole("status")).toBeVisible();
	await page.getByTestId("password").fill("pw-123456");
	await page.getByTestId("signin").click();
	await expect(page.getByTestId("workspace")).toBeVisible();
	await waitWorkspaceReady(page);
	await goToSettings(page);
	await expect(page.getByTestId("account-display-name")).toHaveValue(
		"Maya Chen",
	);

	const observerContext = await browser.newContext();
	const observer = await observerContext.newPage();
	const observerId = await signUp(observer, uniqueEmail("name-observer"));
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	const user = await pool.query('select id from "user" where email=$1', [
		email,
	]);
	for (const userId of [user.rows[0].id, observerId])
		await pool.query(
			"insert into membership(id,user_id,workspace_id,role) values ($1,$2,'w_shared_e2e','member')",
			[crypto.randomUUID(), userId],
		);
	const sharedList = await pool.query(
		"select id from list where workspace_id='w_shared_e2e' and title='Shared list'",
	);
	const taskId = crypto.randomUUID();
	await pool.query(
		"insert into task(id,list_id,title,sort_key) values ($1,$2,'Name sync task','a0')",
		[taskId, sharedList.rows[0].id],
	);
	await pool.query(
		"insert into task_assignee(id,task_id,user_id) values ($1,$2,$3)",
		[crypto.randomUUID(), taskId, user.rows[0].id],
	);
	await openShared(observer);
	await openMembers(observer);
	await expect(
		observer.getByTestId("member-row").filter({ hasText: "Maya Chen" }),
	).toBeVisible();
	await observer
		.getByTestId("members-panel")
		.getByRole("button", { name: "Close", exact: true })
		.click();
	await expect(observer.getByTestId("members-panel")).toHaveCount(0);
	const chips = observer
		.getByTestId("list")
		.locator("button", { hasText: "Name sync task" })
		.getByTestId("assignee-chips");
	await expect(chips).toHaveAttribute("title", /Maya Chen/);
	await page.getByTestId("account-display-name").fill("  Maya  ");
	await page.getByTestId("save-display-name").click();
	await expect(
		page.getByRole("status").filter({ hasText: "Display name saved." }),
	).toBeVisible();
	await expect(chips).toHaveAttribute("title", /Maya/);
	await expect(chips).not.toHaveAttribute("title", /Maya Chen/);
	await openMembers(observer);
	await expect(
		observer.getByTestId("member-row").getByText("Maya", { exact: true }),
	).toBeVisible();
	await expect(
		observer.getByTestId("member-row").filter({ hasText: "Maya Chen" }),
	).toHaveCount(0);
	await page.reload();
	await goToSettings(page);
	await expect(page.getByTestId("account-display-name")).toHaveValue("Maya");
	try {
		const result = await pool.query('select name from "user" where email=$1', [
			email,
		]);
		expect(result.rows).toEqual([{ name: "Maya" }]);
	} finally {
		await pool.end();
		await observerContext.close();
	}
});
