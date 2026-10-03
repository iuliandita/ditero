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
			"insert into user_pref(id,locale,theme) values ($1,'ar','dark') on conflict(id) do update set locale='ar',theme='dark'",
			[actor],
		);
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
