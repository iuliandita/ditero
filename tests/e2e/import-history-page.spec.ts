import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import {
	goToSettings,
	openMobileLists,
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

test("requested mixed history uses complete total pages and source attribution across desktop light and mobile dark RTL", async ({
	page,
}, testInfo) => {
	test.setTimeout(120_000);
	const url = process.env.E2E_DATABASE_URL;
	if (!url) throw new Error("E2E_DATABASE_URL is required");
	const pool = new Pool({ connectionString: url });
	const listId = randomUUID();
	const taskId = randomUUID();
	const templateId = randomUUID();
	const source = randomUUID();
	const title = `Mixed history ${taskId.slice(0, 8)}`;
	const at = new Date("2020-01-02T03:04:05Z");
	const longName = `Claim ${"x".repeat(470)} علي`;
	try {
		const email = uniqueEmail("mixed-history");
		await signUp(page, email);
		await waitWorkspaceReady(page);
		const actor = (
			await pool.query<{ id: string }>('select id from "user" where email=$1', [
				email,
			])
		).rows[0]?.id;
		if (!actor) throw new Error("Missing history account");
		const workspace = (
			await pool.query<{ id: string }>(
				"select id from workspace where owner_id=$1 and kind='personal'",
				[actor],
			)
		).rows[0]?.id;
		if (!workspace) throw new Error("Missing history workspace");
		await pool.query(
			"insert into list(id,workspace_id,owner_id,title,sort_key) values ($1,$2,$3,$4,'a0')",
			[listId, workspace, actor, title],
		);
		await pool.query(
			"insert into task(id,list_id,title,sort_key) values ($1,$2,'Mixed task','a0')",
			[taskId, listId],
		);
		for (let i = 0; i < 105; i++)
			await pool.query(
				`insert into task_completion_event(id,task_id,actor_user_id,recorded_at,origin,action,before_due_all_day,before_done,after_done) values($1,$2,$3,$4,'member_mutation','complete',false,false,true)`,
				[randomUUID(), taskId, actor, at],
			);
		for (let i = 0; i < 100; i++)
			await pool.query(
				`insert into imported_completion_event(id,task_id,source_namespace,source_row_id,occurred_at,actor_kind,actor_namespace,actor_principal_id,actor_name,origin_kind,origin_mechanism,origin_label,action,before_due_all_day,before_done,after_done) values ($1,$2,$3,$4,$5,'source_claim',$3,$6,$7,'source_claim','member_mutation','Older household app','complete',false,false,true)`,
				[randomUUID(), taskId, source, `source-${i}`, at, actor, longName],
			);
		await pool.query(
			`insert into template(id,workspace_id,kind,name,content,created_by,source_namespace,source_row_id,historical_creator_kind,historical_creator_namespace,historical_creator_principal_id,historical_creator_name,imported_at) values ($1,$2,'list','Imported template','{"kind":"list","listKind":"tasks","tasks":[]}',$3,$4,'raw-template','source_claim',$4,$3,$5,now())`,
			[templateId, workspace, actor, source, longName],
		);
		await sidebarLists(page)
			.getByRole("button", { name: title, exact: true })
			.last()
			.click();
		await page
			.getByTestId("list")
			.getByText("Mixed task", { exact: true })
			.click();
		let detail = page.getByTestId("task-detail");
		await detail
			.getByRole("button", { name: "Completion history", exact: true })
			.click();
		let history = detail.getByTestId("completion-history-page");
		await expect(
			history.getByRole("button", { name: "Next", exact: true }),
		).toBeEnabled();
		await expect(history.getByTestId("completion-history-row")).toHaveCount(
			100,
		);
		await expect(
			history.getByTestId("history-imported-attribution"),
		).toHaveCount(0);
		await history.getByRole("button", { name: "Next", exact: true }).click();
		await expect(history.getByTestId("completion-history-row")).toHaveCount(
			100,
		);
		await expect(
			history.getByTestId("history-imported-attribution"),
		).toHaveCount(95);
		await history.getByRole("button", { name: "Next", exact: true }).click();
		await expect(history.getByTestId("completion-history-row")).toHaveCount(5);
		await expect(
			history.getByTestId("history-imported-attribution"),
		).toHaveCount(5);
		await expect(history).toContainText("Source-reported person:");
		await expect(history).toContainText("Source-reported origin:");
		await expect(history).not.toContainText(source);
		expect(
			(
				await new AxeBuilder({ page })
					.include('[data-testid="task-detail"]')
					.analyze()
			).violations,
		).toEqual([]);
		await page.screenshot({
			path: testInfo.outputPath("history-desktop-light.png"),
		});
		await page.keyboard.press("Escape");
		await expect(detail).toHaveCount(0);
		await goToSettings(page);
		const attribution = page.getByTestId("template-attribution");
		await attribution.locator("summary").click();
		await expect(attribution).toContainText("Source-reported creator:");
		await expect(attribution).not.toContainText(source);
		await pool.query(
			"insert into user_pref(id,theme) values ($1,'dark') on conflict(id) do update set theme='dark'",
			[actor],
		);
		await page.getByTestId("language-switcher").click();
		const localeLoaded = page.waitForEvent("load", { timeout: 30_000 });
		await page.getByRole("option", { name: "العربية", exact: true }).click();
		await localeLoaded;
		await expect(page.locator("html")).toHaveAttribute("lang", "ar");
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
		await page.setViewportSize({ width: 390, height: 844 });
		await page.reload();
		await waitWorkspaceReady(page);
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
		await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
		await openMobileLists(page);
		await page
			.getByTestId("list-index")
			.getByRole("button", { name: title, exact: true })
			.last()
			.click();
		await page
			.getByTestId("list")
			.getByText("Mixed task", { exact: true })
			.click();
		detail = page.getByTestId("task-detail");
		await detail
			.getByRole("button", { name: "سجل الإكمال", exact: true })
			.click();
		history = detail.getByTestId("completion-history-page");
		await expect(
			history.getByRole("button", { name: "التالي", exact: true }),
		).toBeEnabled();
		await history.getByRole("button", { name: "التالي", exact: true }).click();
		await expect(
			history.getByTestId("history-imported-attribution"),
		).toHaveCount(95);
		await history.getByRole("button", { name: "التالي", exact: true }).click();
		await expect(
			history.getByTestId("history-imported-attribution"),
		).toHaveCount(5);
		await expect(history).toContainText("الشخص الذي ذكره المصدر:");
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);
		expect(
			(
				await new AxeBuilder({ page })
					.include('[data-testid="task-detail"]')
					.analyze()
			).violations,
		).toEqual([]);
		await page.screenshot({
			path: testInfo.outputPath("history-mobile-dark-rtl.png"),
		});
	} finally {
		await pool.query("delete from template where id=$1", [templateId]);
		await pool.query("delete from task where id=$1", [taskId]);
		await pool.query("delete from list where id=$1", [listId]);
		await pool.end();
	}
});

test("an authoritative history refusal stays hidden offline and through pending retries until authorized success", async ({
	page,
}) => {
	const url = process.env.E2E_DATABASE_URL;
	if (!url) throw new Error("E2E_DATABASE_URL is required");
	const pool = new Pool({ connectionString: url });
	const listId = randomUUID();
	const taskId = randomUUID();
	const otherTaskId = randomUUID();
	const title = `Refusal history ${taskId.slice(0, 8)}`;
	let mode: "pass" | "deny" | "hold" = "pass";
	const pending = new Set<(authorized: boolean) => void>();
	await page.route("**/api/tasks/history?*", async (route) => {
		if (new URL(route.request().url()).searchParams.get("taskId") !== taskId)
			return route.continue();
		if (mode === "deny")
			return route.fulfill({
				status: 404,
				json: { code: "history-unavailable" },
			});
		if (mode === "hold") {
			const authorized = await new Promise<boolean>((resolve) =>
				pending.add(resolve),
			);
			if (!authorized)
				return route.fulfill({
					status: 503,
					json: { code: "history-load-failed" },
				});
		}
		return route.continue();
	});
	try {
		const email = uniqueEmail("history-refusal");
		await signUp(page, email);
		await waitWorkspaceReady(page);
		const actor = (
			await pool.query<{ id: string }>('select id from "user" where email=$1', [
				email,
			])
		).rows[0]?.id;
		if (!actor) throw new Error("Missing refusal account");
		const workspace = (
			await pool.query<{ id: string }>(
				"select id from workspace where owner_id=$1 and kind='personal'",
				[actor],
			)
		).rows[0]?.id;
		if (!workspace) throw new Error("Missing refusal workspace");
		await pool.query(
			"insert into list(id,workspace_id,owner_id,title,sort_key) values ($1,$2,$3,$4,'a0')",
			[listId, workspace, actor, title],
		);
		await pool.query(
			"insert into task(id,list_id,title,sort_key) values ($1,$3,'Cached history','a0'),($2,$3,'Other history','a1')",
			[taskId, otherTaskId, listId],
		);
		for (const id of [taskId, otherTaskId])
			await pool.query(
				`insert into task_completion_event(id,task_id,actor_user_id,recorded_at,origin,action,before_due_all_day,before_done,after_done) values($1,$2,$3,$4,'member_mutation','complete',false,false,true)`,
				[randomUUID(), id, actor, new Date("2020-01-02T03:04:05Z")],
			);
		await sidebarLists(page)
			.getByRole("button", { name: title, exact: true })
			.click();
		await page
			.getByTestId("list")
			.getByText("Cached history", { exact: true })
			.click();
		const detail = page.getByTestId("task-detail");
		const toggle = detail.getByRole("button", {
			name: "Completion history",
			exact: true,
		});
		await toggle.click();
		const history = detail.getByTestId("completion-history-page");
		const rows = history.getByTestId("completion-history-row");
		await expect(rows).toHaveCount(1);
		// Positive offline control: the native row and its task/member context are cached.
		await page.context().setOffline(true);
		await expect(history).toContainText("not fully available offline");
		await expect(rows).toHaveCount(1);
		const allowed = page.waitForResponse(
			(response) =>
				response.url().includes("/api/tasks/history?") &&
				response.status() === 200,
		);
		await page.context().setOffline(false);
		await allowed;
		mode = "deny";
		await pool.query('update "user" set name=$1 where id=$2', [
			"Cached refusal actor",
			actor,
		]);
		await expect(history).toContainText("This task's history is unavailable.");
		await expect(rows).toHaveCount(0);
		await expect(
			detail.getByText("Cached history", { exact: true }),
		).toBeVisible();
		await page.context().setOffline(true);
		await expect(history).toContainText("This task's history is unavailable.");
		await expect(rows).toHaveCount(0);
		await toggle.click();
		await expect(history).toHaveCount(0);
		await toggle.click();
		await expect(history).toContainText("This task's history is unavailable.");
		await expect(rows).toHaveCount(0);
		mode = "hold";
		await page.context().setOffline(false);
		await expect.poll(() => pending.size).toBeGreaterThan(0);
		await expect(history).toContainText("This task's history is unavailable.");
		await expect(rows).toHaveCount(0);
		const retry = history.getByRole("button", {
			name: "Try again",
			exact: true,
		});
		await expect(retry).toBeDisabled();
		for (const release of pending) release(false);
		pending.clear();
		await expect(retry).toBeEnabled();
		await expect(rows).toHaveCount(0);
		await retry.click();
		await expect.poll(() => pending.size).toBeGreaterThan(0);
		await expect(history).toContainText("This task's history is unavailable.");
		await expect(rows).toHaveCount(0);
		for (const release of pending) release(true);
		pending.clear();
		mode = "pass";
		await expect(rows).toHaveCount(1);
		await expect(history).toContainText("Cached refusal actor");
		await expect(history).not.toContainText(
			"This task's history is unavailable.",
		);
		await page.keyboard.press("Escape");
		await expect(detail).toHaveCount(0);
		await page
			.getByTestId("list")
			.getByText("Other history", { exact: true })
			.click();
		await page
			.getByTestId("task-detail")
			.getByRole("button", { name: "Completion history", exact: true })
			.click();
		await expect(page.getByTestId("completion-history-row")).toHaveCount(1);
	} finally {
		mode = "pass";
		for (const release of pending) release(false);
		pending.clear();
		await page.context().setOffline(false);
		await page.unrouteAll({ behavior: "wait" });
		await pool.query("delete from task where id=any($1::text[])", [
			[taskId, otherTaskId],
		]);
		await pool.query("delete from list where id=$1", [listId]);
		await pool.end();
	}
});
