import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { type Download, expect, test } from "@playwright/test";
import { Pool } from "pg";
import type { PortableExportV2 } from "../../src/domain/portability/v2.ts";
import {
	chooseOption,
	goToSettings,
	leaveSettings,
	openDetails,
	sidebarLists,
	signUp,
	switchWorkspace,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

async function downloaded(download: Download) {
	expect(download.suggestedFilename()).toBe("ditero-history-v2.json");
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	const document: PortableExportV2 = JSON.parse(
		Buffer.concat(chunks).toString("utf8"),
	);
	expect(document.format).toBe("ditero");
	expect(document.schemaVersion).toBe(2);
	expect(document.boundaries.taskHistory).toBe("recorded-events-only");
	return document;
}
async function ledgerCount(pool: Pool, workspace: string) {
	return (
		await pool.query(
			`select count(*)::int as n from import_history_ledger where target_parent_id=$1 or target_parent_id in (select t.id from task t join list l on l.id=t.list_id where l.workspace_id=$1)`,
			[workspace],
		)
	).rows[0].n;
}
async function effects(pool: Pool) {
	return (
		await pool.query(
			`select (select count(*) from task_completion_event)::int as native, (select count(*) from karma_event)::int as karma_events, (select count(*) from karma)::int as karma, (select count(*) from notification_outbox)::int as notifications, (select count(*) from reminder_state)::int as reminders`,
		)
	).rows[0];
}

test("Settings v2 history roundtrip survives a lost batch response and preserves source claims without native effects", async ({
	page,
}, info) => {
	test.setTimeout(120_000);
	const databaseURL = process.env.E2E_DATABASE_URL;
	if (!databaseURL) throw new Error("E2E_DATABASE_URL is required");
	const pool = new Pool({ connectionString: databaseURL });
	const listId = randomUUID();
	const taskId = randomUUID();
	const targetWorkspace = randomUUID();
	const targetWorkspaceName = `History destination ${taskId.slice(0, 8)}`;
	const authorId = randomUUID();
	const namespace = randomUUID();
	const sourceTitle = `History source ${taskId.slice(0, 8)}`;
	const targetTitle = `History imported ${taskId.slice(0, 8)}`;
	const targetTask = `Imported history task ${taskId.slice(0, 8)}`;
	try {
		const email = uniqueEmail("history-roundtrip");
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
		if (!workspace) throw new Error("Missing personal workspace");
		await pool.query(
			"insert into workspace(id,name,owner_id,kind) values($1,$2,$3,'shared')",
			[targetWorkspace, targetWorkspaceName, actor],
		);
		await pool.query(
			"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner')",
			[randomUUID(), actor, targetWorkspace],
		);
		await pool.query(
			`insert into "user"(id,name,email,email_verified) values($1,'Original author',$2,false)`,
			[authorId, `${authorId}@example.test`],
		);
		await pool.query(
			"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,$4,'a0')",
			[listId, workspace, actor, sourceTitle],
		);
		await pool.query(
			"insert into task(id,list_id,title,sort_key) values($1,$2,'Original history task','a0')",
			[taskId, listId],
		);
		await pool.query(
			"insert into comment(id,task_id,author_id,body,created_at) select $1||i,$2,$3,'Original comment '||i,'2020-01-02T03:04:05Z' from generate_series(1,105) i",
			[`${taskId}-comment-`, taskId, authorId],
		);
		for (const kind of ["task", "list"]) {
			const content =
				kind === "task"
					? { kind: "task", task: { title: "Reusable history" } }
					: { kind: "list", listKind: "tasks", tasks: [] };
			await pool.query(
				"insert into template(id,workspace_id,kind,name,content,created_by) values($1,$2,$3,$4,$5,$6)",
				[
					randomUUID(),
					workspace,
					kind,
					`Native ${kind} template`,
					JSON.stringify(content),
					actor,
				],
			);
			await pool.query(
				`insert into template(id,workspace_id,kind,name,content,created_by,source_namespace,source_row_id,historical_creator_kind,historical_creator_namespace,historical_creator_principal_id,historical_creator_name,imported_at) values($1,$2,$3,$4,$5,$6,$7,$8,'source_claim',$7,$9,'Claimed creator',now())`,
				[
					randomUUID(),
					workspace,
					kind,
					`Claimed ${kind} template`,
					JSON.stringify(content),
					actor,
					namespace,
					`original-${kind}-template`,
					authorId,
				],
			);
		}
		for (let index = 0; index < 110; index++) {
			const action = ["complete", "reopen", "skip", "habit_set", "habit_unlog"][
				index % 5
			];
			const origin =
				index % 2 === 0 ? "member_mutation" : "capability_recipient";
			if (action === "habit_set" || action === "habit_unlog")
				await pool.query(
					`insert into task_completion_event(id,task_id,actor_user_id,origin,recorded_at,action,habit_date,before_habit_status,after_habit_status) values($1,$2,$3,$4,'2020-01-02T03:04:05Z',$5,'2020-01-02','done',$6)`,
					[
						randomUUID(),
						taskId,
						authorId,
						origin,
						action,
						action === "habit_set" ? "skipped" : null,
					],
				);
			else
				await pool.query(
					`insert into task_completion_event(id,task_id,actor_user_id,origin,recorded_at,action,before_due_all_day,before_done,after_done,after_due_at) values($1,$2,$3,$4,'2020-01-02T03:04:05Z',$5,false,$6,$7,$8)`,
					[
						randomUUID(),
						taskId,
						authorId,
						origin,
						action,
						action === "reopen",
						action !== "reopen",
						action === "skip" ? new Date("2020-01-03T03:04:05Z") : null,
					],
				);
		}
		for (let index = 0; index < 3; index++) {
			const claimed = index === 0;
			await pool.query(
				`insert into comment(id,task_id,body,created_at,source_namespace,source_row_id,historical_author_kind,historical_author_namespace,historical_author_principal_id,historical_author_name,imported_at,provenance_redacted_at) values($1,$2,$3,'2020-01-02T03:04:05Z',$4,$5,$6,$7,$8,$9,now(),$10)`,
				[
					randomUUID(),
					taskId,
					`Retained comment ${index}`,
					namespace,
					claimed ? "" : `old-comment-${index}`,
					claimed ? "source_claim" : "unknown",
					claimed ? namespace : null,
					claimed ? authorId : null,
					claimed ? "Claimed author" : null,
					index === 2 ? new Date() : null,
				],
			);
			await pool.query(
				`insert into imported_completion_event(id,task_id,source_namespace,source_row_id,occurred_at,actor_kind,actor_namespace,actor_principal_id,actor_name,origin_kind,origin_mechanism,origin_label,action,before_due_all_day,before_done,after_done,provenance_redacted_at) values($1,$2,$3,$4,'2020-01-02T03:04:05Z',$5,$6,$7,$8,$5,$9,$10,'complete',false,false,true,$11)`,
				[
					randomUUID(),
					taskId,
					namespace,
					claimed ? "" : `old-event-${index}`,
					claimed ? "source_claim" : "unknown",
					claimed ? namespace : null,
					claimed ? authorId : null,
					claimed ? "Claimed author" : null,
					claimed ? "capability_recipient" : null,
					claimed ? "Older household app" : null,
					index === 2 ? new Date() : null,
				],
			);
		}
		for (const kind of ["ntfy", "telegram", "discord", "slack", "email"])
			await pool.query(
				"insert into notification_channel(id,user_id,kind,config) values($1,$2,$3,$4)",
				[
					randomUUID(),
					actor,
					kind,
					JSON.stringify({ marker: `SECRET-${kind}` }),
				],
			);
		await expect(
			sidebarLists(page)
				.getByRole("button", { name: sourceTitle, exact: true })
				.last(),
		).toBeVisible();
		const before = await effects(pool);
		await goToSettings(page);
		const downloadEvent = page.waitForEvent("download");
		await page
			.getByRole("button", { name: "Download JSON", exact: true })
			.click();
		const archive: PortableExportV2 = await downloaded(await downloadEvent);
		expect(archive.data.completionEvents).toHaveLength(113);
		expect(archive.data.templates).toHaveLength(4);
		expect(archive.data.comments).toHaveLength(108);
		expect(JSON.stringify(archive)).not.toContain("SECRET-");
		const sourceList = archive.data.lists.find((row) => row.id === listId);
		const sourceTask = archive.data.tasks.find((row) => row.id === taskId);
		const sourceWorkspace = archive.data.workspaces.find(
			(row) => row.id === workspace,
		);
		if (!sourceList || !sourceTask || !sourceWorkspace)
			throw new Error("Missing exported source");
		sourceList.title = targetTitle;
		sourceTask.title = targetTask;
		const panel = page.getByRole("region", { name: "Plan an import" });
		await panel.getByLabel("Native JSON export").setInputFiles({
			name: "ditero-history-v2.json",
			mimeType: "application/json",
			buffer: Buffer.from(JSON.stringify(archive)),
		});
		await panel.getByLabel("Source label").fill("Historical archive");
		await expect(panel.getByTestId("import-workspace")).toHaveCount(
			archive.data.workspaces.length,
		);
		for (const trigger of await panel.getByTestId("import-workspace").all())
			await chooseOption(page, trigger, targetWorkspaceName);
		const saved = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === "/api/portability/import/plans" &&
				response.ok(),
		);
		await panel
			.getByRole("button", { name: "Save dry run", exact: true })
			.click();
		const job = await (await saved).json();
		expect(job.report).toMatchObject({
			plannerVersion: 5,
			applySupported: true,
		});
		expect(await effects(pool)).toEqual(before);
		expect(await ledgerCount(pool, targetWorkspace)).toBe(0);
		await expect(panel).toContainText("These claims do not prove identity");
		expect(
			(await new AxeBuilder({ page }).include("#import-plan").analyze())
				.violations,
		).toEqual([]);
		await panel.screenshot({
			path: info.outputPath("history-v2-review-desktop.png"),
		});
		let committedCursor = 0;
		await page.route(
			`**/api/portability/import/plans/${job.id}/apply`,
			async (route) => {
				const response = await route.fetch();
				expect(response.status()).toBe(200);
				const run = await response.json();
				expect(run.state).toBe("running");
				committedCursor = run.nextOrdinal;
				await route.fulfill({
					status: 503,
					contentType: "application/json",
					body: JSON.stringify({ code: "unavailable" }),
				});
			},
			{ times: 1 },
		);
		await panel
			.getByRole("button", { name: "Apply import", exact: true })
			.click();
		await page.getByTestId("confirm-accept").click();
		await expect(panel.getByRole("alert")).toContainText(
			"Some entries may already be imported",
		);
		expect(committedCursor).toBe(100);
		await panel
			.getByRole("button", { name: "Resume import", exact: true })
			.click();
		await expect(panel.getByTestId("import-apply-status")).toContainText(
			"Import completed.",
			{ timeout: 20_000 },
		);
		expect(await effects(pool)).toEqual(before);
		const ledger = await ledgerCount(pool, targetWorkspace);
		expect(ledger).toBe(225);
		const replay = await page.request.post(
			`/api/portability/import/plans/${job.id}/apply`,
			{
				headers: { origin: new URL(page.url()).origin },
				data: { planDigest: job.planDigest, counts: job.report.counts },
			},
		);
		expect(replay.ok()).toBe(true);
		expect((await replay.json()).state).toBe("completed");
		expect(await ledgerCount(pool, targetWorkspace)).toBe(ledger);
		await leaveSettings(page);
		await switchWorkspace(page, targetWorkspaceName);
		await sidebarLists(page)
			.getByRole("button", { name: targetTitle, exact: true })
			.last()
			.click();
		await openDetails(page, targetTask);
		const detail = page.getByTestId("task-detail");
		await expect(detail).toContainText("Retained comment 0");
		await detail
			.getByRole("button", { name: "Completion history", exact: true })
			.click();
		const history = detail.getByTestId("completion-history-page");
		await expect(history.getByTestId("completion-history-row")).toHaveCount(
			100,
		);
		await expect(
			history.getByTestId("history-imported-attribution"),
		).toHaveCount(100);
		await history.getByRole("button", { name: "Next", exact: true }).click();
		await expect(history.getByTestId("completion-history-row")).toHaveCount(13);
		await expect(history).toContainText("Source-reported person:");
		const targetId = (
			await pool.query<{ id: string }>("select id from task where title=$1", [
				targetTask,
			])
		).rows[0].id;
		expect(
			(await pool.query("select done,due_at from task where id=$1", [targetId]))
				.rows[0],
		).toEqual({
			done: sourceTask.done,
			due_at: sourceTask.dueAt === null ? null : new Date(sourceTask.dueAt),
		});
		expect(
			(
				await pool.query(
					"select count(*)::int as n from comment where task_id=$1 and author_id is not null",
					[targetId],
				)
			).rows[0].n,
		).toBe(0);
		expect(
			(
				await pool.query(
					"select count(*)::int as n from membership where user_id=$1",
					[authorId],
				)
			).rows[0].n,
		).toBe(0);
		await page.keyboard.press("Escape");
		await expect(detail).toHaveCount(0);
		await goToSettings(page);
		const reexportEvent = page.waitForEvent("download");
		await page
			.getByRole("button", { name: "Download JSON", exact: true })
			.click();
		const reexport = await downloaded(await reexportEvent);
		const targetComments = reexport.data.comments.filter(
			(row) => row.taskId === targetId,
		);
		expect(targetComments).toHaveLength(108);
		expect(targetComments.map((row) => row.sourceRef)).toEqual(
			expect.arrayContaining(archive.data.comments.map((row) => row.sourceRef)),
		);
		expect(
			targetComments.find((row) => row.sourceRef.id === "")?.author,
		).toEqual({
			kind: "source_claim",
			sourceNamespace: namespace,
			sourcePrincipalId: authorId,
			displayName: "Claimed author",
		});
		expect(
			reexport.data.completionEvents
				.filter((row) => row.taskId === targetId)
				.map((row) => row.sourceRef),
		).toEqual(
			expect.arrayContaining(
				archive.data.completionEvents.map((row) => row.sourceRef),
			),
		);
		expect(await effects(pool)).toEqual(before);
		await pool.query(
			"insert into user_pref(id,locale,theme) values($1,'ar','dark') on conflict(id) do update set locale='ar',theme='dark'",
			[actor],
		);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.reload();
		await waitWorkspaceReady(page);
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
		await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
		await goToSettings(page);
		const mobile = page.locator("#import-plan");
		expect(
			(await new AxeBuilder({ page }).include("#import-plan").analyze())
				.violations,
		).toEqual([]);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);
		await mobile.screenshot({
			path: info.outputPath("history-v2-mobile-dark-rtl.png"),
		});
	} finally {
		await pool.end();
	}
});
