import { createHash, randomBytes, randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { type BrowserContext, expect, test } from "@playwright/test";
import { Pool } from "pg";
import {
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

test.describe.configure({ timeout: 90_000 });

test("task detail shows native changes, paginates only the opened history, and keeps a complete cached page offline", async ({
	page,
}) => {
	const databaseURL = process.env.E2E_DATABASE_URL;
	if (!databaseURL) throw new Error("E2E_DATABASE_URL is required");
	const pool = new Pool({ connectionString: databaseURL });
	const listId = randomUUID();
	const taskId = randomUUID();
	const title = `History ${taskId.slice(0, 8)}`;
	try {
		const email = uniqueEmail("completion-history");
		await signUp(page, email);
		await waitWorkspaceReady(page);
		const actor = (
			await pool.query<{ id: string }>('select id from "user" where email=$1', [
				email,
			])
		).rows[0]?.id;
		if (!actor) throw new Error("History actor is missing");
		const workspace = (
			await pool.query<{ id: string }>(
				"select id from workspace where owner_id=$1 and kind='personal'",
				[actor],
			)
		).rows[0]?.id;
		if (!workspace) throw new Error("Personal workspace is missing");
		await pool.query(
			"insert into list(id,workspace_id,owner_id,title,kind,sort_key) values($1,$2,$3,$4,'tasks','a0')",
			[listId, workspace, actor, title],
		);
		await pool.query(
			"insert into task(id,list_id,title,sort_key) values($1,$2,'Record me','a0')",
			[taskId, listId],
		);
		await sidebarLists(page)
			.getByRole("button", { name: title, exact: true })
			.last()
			.click();
		const list = page.getByTestId("list");
		await list.getByRole("checkbox", { name: "Record me" }).check();
		await expect
			.poll(
				async () =>
					(
						await pool.query<{ count: number }>(
							"select count(*)::int as count from task_completion_event where task_id=$1",
							[taskId],
						)
					).rows[0]?.count,
			)
			.toBe(1);

		await list.getByText("Record me", { exact: true }).click();
		let detail = page.getByRole("dialog", { name: "Task details" });
		await detail.getByRole("button", { name: "Completion history" }).click();
		const history = detail.getByTestId("completion-history-page");
		await expect(history.getByTestId("completion-history-row")).toHaveCount(1);
		await expect(history).toContainText("completed the task");
		await expect(history).toContainText("Unknown date");
		await pool.query('update "user" set name=$1 where id=$2', [
			"Updated history actor",
			actor,
		]);
		await expect(history).toContainText("Updated history actor");
		await page.keyboard.press("Escape");
		await list.getByRole("checkbox", { name: "Record me" }).uncheck();
		await expect
			.poll(
				async () =>
					(
						await pool.query<{ count: number }>(
							"select count(*)::int as count from task_completion_event where task_id=$1",
							[taskId],
						)
					).rows[0]?.count,
			)
			.toBe(2);

		const old = new Date("2020-01-01T12:00:00.123Z");
		for (let index = 0; index < 101; index += 1) {
			await pool.query(
				`insert into task_completion_event
				(id,task_id,actor_user_id,recorded_at,origin,action,before_due_all_day,before_done,after_done)
				values($1,$2,$3,$4,'member_mutation','complete',false,false,true)`,
				[randomUUID(), taskId, actor, old],
			);
		}
		await list.getByText("Record me", { exact: true }).click();
		detail = page.getByRole("dialog", { name: "Task details" });
		await detail.getByRole("button", { name: "Completion history" }).click();
		const pageOfHistory = detail.getByTestId("completion-history-page");
		await expect(
			pageOfHistory.getByTestId("completion-history-row"),
		).toHaveCount(100, { timeout: 15_000 });
		await expect(pageOfHistory).toContainText("reopened the task");
		await page.context().setOffline(true);
		await expect(
			pageOfHistory.getByTestId("completion-history-row"),
		).toHaveCount(100);
		await pageOfHistory.getByRole("button", { name: "Next" }).click();
		await expect(pageOfHistory).toContainText("not fully available offline");
		await page.context().setOffline(false);
		await expect(
			pageOfHistory.getByTestId("completion-history-row"),
		).toHaveCount(3, { timeout: 20_000 });
		await pageOfHistory.getByRole("button", { name: "Previous" }).click();
		await expect(
			pageOfHistory.getByTestId("completion-history-row"),
		).toHaveCount(100);
	} finally {
		await page.context().setOffline(false);
		await pool.query("delete from task where id=$1", [taskId]);
		await pool.query("delete from list where id=$1", [listId]);
		await pool.end();
	}
});

test("restricted mobile reader sees Arabic history and loses it after membership revocation", async ({
	browser,
	page,
}, testInfo) => {
	const databaseURL = process.env.E2E_DATABASE_URL;
	if (!databaseURL) throw new Error("E2E_DATABASE_URL is required");
	const pool = new Pool({ connectionString: databaseURL });
	let restrictedContext: BrowserContext | null = null;
	const workspace = randomUUID();
	const listId = randomUUID();
	const taskId = randomUUID();
	const capabilityTaskId = randomUUID();
	const reminderId = randomUUID();
	const capabilityId = randomUUID();
	const managedId = randomUUID();
	const token = randomBytes(32).toString("base64url");
	try {
		const ownerEmail = uniqueEmail("history-mobile-owner");
		const readerEmail = uniqueEmail("history-mobile-reader");
		await signUp(page, ownerEmail);
		restrictedContext = await browser.newContext({
			baseURL: new URL(page.url()).origin,
			viewport: { width: 390, height: 844 },
			isMobile: true,
			hasTouch: true,
		});
		const readerPage = await restrictedContext.newPage();
		await readerPage.goto("/");
		const reloaded = readerPage.waitForEvent("load");
		await readerPage.getByTestId("language-switcher").click();
		await readerPage.getByRole("option", { name: "العربية" }).click();
		await reloaded;
		await signUp(readerPage, readerEmail);
		await expect(readerPage.locator("html")).toHaveAttribute("dir", "rtl");
		const users = await pool.query<{ id: string; email: string }>(
			'select id,email from "user" where email=any($1::text[])',
			[[ownerEmail, readerEmail]],
		);
		const owner = users.rows.find((row) => row.email === ownerEmail)?.id;
		const reader = users.rows.find((row) => row.email === readerEmail)?.id;
		if (!owner || !reader) throw new Error("History fixture users are missing");
		const client = await pool.connect();
		try {
			await client.query("begin");
			await client.query(
				"insert into workspace(id,name,owner_id,kind) values($1,'History shared',$2,'shared')",
				[workspace, owner],
			);
			await client.query(
				`insert into membership(id,user_id,workspace_id,role) values
				($1,$3,$5,'owner'),($2,$4,$5,'member')`,
				[randomUUID(), randomUUID(), owner, reader, workspace],
			);
			await client.query(
				"insert into managed_account(id,user_id,guardian_id,restricted) values($1,$2,$3,true)",
				[managedId, reader, owner],
			);
			await client.query(
				"insert into user_pref(id,locale,theme) values($1,'ar','light') on conflict(id) do update set locale='ar',theme='light'",
				[reader],
			);
			await client.query(
				"insert into list(id,workspace_id,owner_id,title,kind,sort_key) values($1,$2,$3,'Mobile history','tasks','a0')",
				[listId, workspace, owner],
			);
			await client.query(
				`insert into task(id,list_id,title,sort_key) values
				($1,$3,'Mobile completion','a0'),($2,$3,'Mobile reminder','a1')`,
				[taskId, capabilityTaskId, listId],
			);
			await client.query(
				`insert into task_assignee(id,task_id,user_id) values
				($1,$3,$5),($2,$4,$5)`,
				[randomUUID(), randomUUID(), taskId, capabilityTaskId, reader],
			);
			await client.query(
				`insert into reminder_state
				(id,task_id,occurrence_at,recipient_user_id,status,fire_count)
				values($1,$2,now(),$3,'pending',1)`,
				[reminderId, capabilityTaskId, reader],
			);
			await client.query(
				`insert into ack_capability
				(id,token_hash,reminder_state_id,recipient_user_id,action,expires_at)
				values($1,$2,$3,$4,'complete',now()+interval '1 day')`,
				[
					capabilityId,
					createHash("sha256").update(token).digest("hex"),
					reminderId,
					reader,
				],
			);
			await client.query("commit");
		} catch (error) {
			await client.query("rollback");
			throw error;
		} finally {
			client.release();
		}
		await expect(readerPage.getByTestId("restricted-shell")).toBeVisible();
		const completed = readerPage
			.getByTestId("restricted-task")
			.filter({ hasText: "Mobile completion" });
		await expect(completed).toBeVisible({ timeout: 15_000 });
		await completed
			.getByRole("checkbox", { name: "Mobile completion" })
			.check();
		await expect
			.poll(
				async () =>
					(
						await pool.query<{ count: number }>(
							"select count(*)::int as count from task_completion_event where task_id=$1",
							[taskId],
						)
					).rows[0]?.count,
			)
			.toBe(1);
		await completed.getByRole("button", { name: "Mobile completion" }).click();
		const detail = readerPage.getByTestId("restricted-detail");
		await detail.getByRole("button", { name: "سجل الإكمال" }).click();
		await expect(detail.getByTestId("completion-history-row")).toHaveCount(1);
		await expect(detail).toContainText("أكمل");
		await expect(readerPage.locator("html")).not.toHaveClass(
			/(^|\s)dark(\s|$)/,
		);
		await readerPage.screenshot({
			path: testInfo.outputPath("history-mobile-ar-light.png"),
			animations: "disabled",
		});
		const { violations } = await new AxeBuilder({ page: readerPage }).analyze();
		expect(
			violations.filter(
				(item) => item.impact === "serious" || item.impact === "critical",
			),
		).toEqual([]);
		await pool.query("update user_pref set theme='dark' where id=$1", [reader]);
		await expect(readerPage.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
		await readerPage.screenshot({
			path: testInfo.outputPath("history-mobile-ar-dark.png"),
			animations: "disabled",
		});
		await readerPage.keyboard.press("Escape");
		const response = await readerPage.request.post(
			`/api/notifications/ack/${token}`,
		);
		expect(response.status()).toBe(200);
		await expect
			.poll(
				async () =>
					(
						await pool.query<{ count: number }>(
							"select count(*)::int as count from task_completion_event where task_id=$1",
							[capabilityTaskId],
						)
					).rows[0]?.count,
			)
			.toBe(1);
		const reminderTask = readerPage
			.getByTestId("restricted-task")
			.filter({ hasText: "Mobile reminder" });
		await reminderTask.getByRole("button", { name: "Mobile reminder" }).click();
		const reminderDetail = readerPage.getByTestId("restricted-detail");
		await reminderDetail.getByRole("button", { name: "سجل الإكمال" }).click();
		await expect(
			reminderDetail.getByTestId("completion-history-row"),
		).toContainText("رابط تذكير");
		await pool.query(
			"delete from membership where workspace_id=$1 and user_id=$2",
			[workspace, reader],
		);
		await expect(
			reminderDetail.getByTestId("completion-history-row"),
		).toHaveCount(0, { timeout: 15_000 });
		await expect(readerPage.getByTestId("restricted-task")).toHaveCount(0);
	} finally {
		await restrictedContext?.close();
		await pool.query("delete from ack_capability where id=$1", [capabilityId]);
		await pool.query("delete from reminder_state where id=$1", [reminderId]);
		await pool.query("delete from task where id=any($1::text[])", [
			[taskId, capabilityTaskId],
		]);
		await pool.query("delete from list where id=$1", [listId]);
		await pool.query("delete from membership where workspace_id=$1", [
			workspace,
		]);
		await pool.query("delete from workspace where id=$1", [workspace]);
		await pool.end();
	}
});

test("recurring task and habit controls show their distinct recorded transitions", async ({
	page,
}) => {
	const databaseURL = process.env.E2E_DATABASE_URL;
	if (!databaseURL) throw new Error("E2E_DATABASE_URL is required");
	const pool = new Pool({ connectionString: databaseURL });
	const taskListId = randomUUID();
	const habitListId = randomUUID();
	const recurringId = randomUUID();
	const habitId = randomUUID();
	const taskListName = `History recurring ${taskListId.slice(0, 8)}`;
	const habitListName = `History habits ${habitListId.slice(0, 8)}`;
	try {
		const email = uniqueEmail("history-recurrence");
		await signUp(page, email);
		await waitWorkspaceReady(page);
		const actor = (
			await pool.query<{ id: string }>('select id from "user" where email=$1', [
				email,
			])
		).rows[0]?.id;
		if (!actor) throw new Error("History actor is missing");
		const workspace = (
			await pool.query<{ id: string }>(
				"select id from workspace where owner_id=$1 and kind='personal'",
				[actor],
			)
		).rows[0]?.id;
		if (!workspace) throw new Error("Personal workspace is missing");
		await pool.query(
			`insert into list(id,workspace_id,owner_id,title,kind,sort_key) values
			($1,$3,$4,$5,'tasks','a0'),($2,$3,$4,$6,'habits','a1')`,
			[taskListId, habitListId, workspace, actor, taskListName, habitListName],
		);
		await pool.query(
			`insert into task(id,list_id,title,sort_key,due_at,rrule) values
			($1,$3,'Recurring history','a0',now()+interval '1 day','FREQ=DAILY'),
			($2,$4,'Habit history','a0',now()+interval '1 day','FREQ=DAILY')`,
			[recurringId, habitId, taskListId, habitListId],
		);
		await sidebarLists(page)
			.getByRole("button", { name: taskListName, exact: true })
			.last()
			.click();
		await page
			.getByTestId("list")
			.getByRole("checkbox", { name: "Recurring history" })
			.click();
		await page
			.getByTestId("list")
			.getByText("Recurring history", { exact: true })
			.click();
		const taskDetail = page.getByRole("dialog", { name: "Task details" });
		await taskDetail.getByTestId("recurrence-skip").click();
		await taskDetail
			.getByRole("button", { name: "Completion history" })
			.click();
		const taskHistory = taskDetail.getByTestId("completion-history-page");
		await expect(taskHistory.getByTestId("completion-history-row")).toHaveCount(
			2,
		);
		await expect(taskHistory).toContainText("completed the task");
		await expect(taskHistory).toContainText("skipped the occurrence");
		const transitions = (
			await pool.query<{
				action: string;
				before_due_at: Date;
				after_due_at: Date;
			}>(
				"select action,before_due_at,after_due_at from task_completion_event where task_id=$1 order by before_due_at",
				[recurringId],
			)
		).rows;
		expect(transitions.map((row) => row.action)).toEqual(["complete", "skip"]);
		expect(transitions[0]?.after_due_at.getTime()).toBe(
			transitions[1]?.before_due_at.getTime(),
		);
		await page.keyboard.press("Escape");
		await sidebarLists(page)
			.getByRole("button", { name: habitListName, exact: true })
			.last()
			.click();
		const card = page
			.getByTestId("habit-card")
			.filter({ hasText: "Habit history" });
		await expect(card).toBeVisible();
		await card.getByTestId("habit-done").click();
		await card.getByTestId("habit-undo").click();
		await card.getByTestId("habit-skip").click();
		await expect
			.poll(
				async () =>
					(
						await pool.query<{ count: number }>(
							"select count(*)::int as count from task_completion_event where task_id=$1",
							[habitId],
						)
					).rows[0]?.count,
			)
			.toBe(3);
		await page
			.getByTestId("list")
			.locator("[data-kbd-nav]")
			.filter({ hasText: "Habit history" })
			.first()
			.click();
		const habitDetail = page.getByRole("dialog", { name: "Task details" });
		await habitDetail
			.getByRole("button", { name: "Completion history" })
			.click();
		const habitHistory = habitDetail.getByTestId("completion-history-page");
		await expect(
			habitHistory.getByTestId("completion-history-row"),
		).toHaveCount(3);
		await expect(habitHistory).toContainText("logged the habit as done");
		await expect(habitHistory).toContainText("removed the habit log");
		await expect(habitHistory).toContainText("marked the habit as skipped");
		const key = (
			await pool.query<{ habit_date: string }>(
				"select habit_date from task_completion_event where task_id=$1 limit 1",
				[habitId],
			)
		).rows[0]?.habit_date;
		if (!key) throw new Error("Habit occurrence date is missing");
		expect(await habitHistory.textContent()).not.toContain(key);
	} finally {
		await pool.query("delete from task where id=any($1::text[])", [
			[recurringId, habitId],
		]);
		await pool.query("delete from list where id=any($1::text[])", [
			[taskListId, habitListId],
		]);
		await pool.end();
	}
});
