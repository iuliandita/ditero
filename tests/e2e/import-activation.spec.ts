import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import { digestImportExpectedRelationships } from "../../src/domain/portability/import-apply-plan.ts";
import {
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

function testPool(): Pool {
	const connectionString = process.env.E2E_DATABASE_URL;
	if (!connectionString) throw new Error("E2E_DATABASE_URL is required");
	return new Pool({ connectionString });
}

async function userId(pool: Pool, email: string): Promise<string> {
	const row = (
		await pool.query<{ id: string }>('select id from "user" where email=$1', [
			email,
		])
	).rows[0];
	if (!row) throw new Error("Signed-up user is missing");
	return row.id;
}

async function personalScope(pool: Pool, ownerId: string) {
	const row = (
		await pool.query<{ workspaceId: string; membershipId: string }>(
			`select w.id as "workspaceId",m.id as "membershipId" from workspace w
			join membership m on m.workspace_id=w.id and m.user_id=w.owner_id
			where w.owner_id=$1 and w.kind='personal' and m.role='owner'`,
			[ownerId],
		)
	).rows[0];
	if (!row) throw new Error("Personal workspace is missing");
	return row;
}

async function seedGuard(
	pool: Pool,
	options: {
		taskId: string;
		status: "pending" | "blocked";
		workspaceId: string;
		ownerId: string;
		ownerMembershipId: string;
		missingAssignees?: number;
	},
) {
	const expected = {
		version: 1 as const,
		workspaceId: options.workspaceId,
		assignees: Array.from(
			{ length: options.missingAssignees ?? 0 },
			(_, index) => ({
				userId: `missing-${options.taskId}-${index}`,
				membershipId: `missing-seat-${options.taskId}-${index}`,
			}),
		),
		ownerFallback: {
			userId: options.ownerId,
			membershipId: options.ownerMembershipId,
		},
		escalationFallback: null,
	};
	const json = JSON.stringify(expected);
	const digest = await digestImportExpectedRelationships(expected, () => {});
	const bytes = (
		await pool.query<{ bytes: number }>(
			"select octet_length($1::jsonb::text)::int as bytes",
			[json],
		)
	).rows[0]?.bytes;
	if (bytes == null) throw new Error("Guard evidence size is missing");
	await pool.query(
		`insert into task_notification_activation
		(task_id,status,generation,blocked_reason,expected_relationship_digest,
		 expected_relationship_count,expected_relationship_bytes,expected_relationships)
		values($1,$2,1,$3,$4,$5,$6,$7::jsonb)`,
		[
			options.taskId,
			options.status,
			options.status === "blocked" ? "import-conflict" : null,
			digest,
			expected.assignees.length + 1,
			bytes,
			json,
		],
	);
}

async function openList(page: Page, title: string) {
	await sidebarLists(page)
		.getByRole("button", { name: title, exact: true })
		.last()
		.click();
	await expect(page.getByTestId("list")).toBeVisible();
}

async function openTask(page: Page, title: string) {
	await page.getByTestId("list").getByText(title, { exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Task details" });
	await expect(dialog).toBeVisible();
	return dialog;
}

async function reviewBothPages(panel: ReturnType<Page["getByTestId"]>) {
	await panel
		.getByRole("button", { name: /^(Review task|Refresh review)$/ })
		.click();
	await expect(panel).toContainText("Page 1 of 2");
	await panel.getByRole("button", { name: "Next" }).click();
	await expect(panel).toContainText("Page 2 of 2");
	await panel
		.getByRole("checkbox", { name: /reviewed the current recipients/i })
		.check();
}

test("pending and blocked tasks wait for activation while native writes and deletion remain available", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const pool = testPool();
	try {
		const email = uniqueEmail("activation-review");
		await signUp(page, email);
		await waitWorkspaceReady(page);
		const actorId = await userId(pool, email);
		const scope = await personalScope(pool, actorId);
		const listId = randomUUID();
		const pendingId = randomUUID();
		const blockedId = randomUUID();
		const nativeId = randomUUID();
		const title = `Activation review ${listId.slice(0, 8)}`;
		const pendingTitle = "Pending imported task";
		const blockedTitle = "Blocked imported task";
		const nativeTitle = "Native task";
		await pool.query(
			"insert into list(id,workspace_id,owner_id,title,kind,sort_key) values($1,$2,$3,$4,'tasks','a0')",
			[listId, scope.workspaceId, actorId, title],
		);
		for (const [id, taskTitle, sortKey] of [
			[pendingId, pendingTitle, "a0"],
			[blockedId, blockedTitle, "a1"],
			[nativeId, nativeTitle, "a2"],
		] as const)
			await pool.query(
				"insert into task(id,list_id,title,sort_key,due_at,reminder_time) values($1,$2,$3,$4,now()+interval '1 day','09:00')",
				[id, listId, taskTitle, sortKey],
			);
		await seedGuard(pool, {
			taskId: pendingId,
			status: "pending",
			workspaceId: scope.workspaceId,
			ownerId: actorId,
			ownerMembershipId: scope.membershipId,
			missingAssignees: 101,
		});
		await seedGuard(pool, {
			taskId: blockedId,
			status: "blocked",
			workspaceId: scope.workspaceId,
			ownerId: actorId,
			ownerMembershipId: scope.membershipId,
		});

		await openList(page, title);
		const list = page.getByTestId("list");
		await expect(
			list.getByRole("checkbox", { name: pendingTitle }),
		).toBeDisabled();
		await expect(
			list.getByRole("checkbox", { name: blockedTitle }),
		).toBeDisabled();
		await expect(
			list.getByRole("checkbox", { name: nativeTitle }),
		).toBeEnabled();
		await list.getByRole("checkbox", { name: nativeTitle }).check();
		await expect
			.poll(
				async () =>
					(
						await pool.query<{ done: boolean }>(
							"select done from task where id=$1",
							[nativeId],
						)
					).rows[0]?.done,
			)
			.toBe(true);

		const dialog = await openTask(page, pendingTitle);
		const panel = dialog.getByTestId("task-import-activation");
		await expect(
			dialog.getByRole("textbox", { name: "Task title" }),
		).toBeDisabled();
		let finishRequests = 0;
		page.on("request", (request) => {
			if (
				request.method() === "POST" &&
				request.url().endsWith(`/tasks/${pendingId}/finish`)
			)
				finishRequests += 1;
		});
		await panel.getByRole("button", { name: "Review task" }).click();
		await expect(panel).toContainText("Review entries: 102");
		await expect(panel).toContainText("Page 1 of 2");
		const finish = panel.getByRole("button", {
			name: "Finish import for this task",
		});
		await panel
			.getByRole("checkbox", { name: /reviewed the current recipients/i })
			.check();
		await expect(finish).toBeDisabled();
		await panel.getByRole("button", { name: "Next" }).click();
		await expect(panel).toContainText("Page 2 of 2");
		await expect(finish).toBeDisabled();
		await panel
			.getByRole("checkbox", { name: /reviewed the current recipients/i })
			.check();
		await expect(finish).toBeEnabled();
		await panel.getByRole("button", { name: "Cancel" }).click();
		await expect(
			panel.getByRole("button", { name: "Review task" }),
		).toBeVisible();
		expect(finishRequests).toBe(0);

		await reviewBothPages(panel);
		await pool.query("update task set title=$1 where id=$2", [
			"Pending imported task changed",
			pendingId,
		]);
		const stale = page.waitForResponse(
			(response) =>
				response.url().endsWith(`/tasks/${pendingId}/finish`) &&
				response.request().method() === "POST",
		);
		await finish.click();
		expect((await stale).status()).toBe(409);
		await expect(panel).toContainText("Load a fresh review");
		await expect(
			panel.getByRole("button", { name: "Refresh review" }),
		).toBeVisible();
		await reviewBothPages(panel);
		const completed = page.waitForResponse(
			(response) =>
				response.url().endsWith(`/tasks/${pendingId}/finish`) &&
				response.request().method() === "POST",
		);
		await panel
			.getByRole("button", { name: "Finish import for this task" })
			.click();
		expect((await completed).status()).toBe(200);
		await expect(
			dialog.getByRole("textbox", { name: "Task title" }),
		).toBeEnabled({
			timeout: 15_000,
		});
		await expect(panel).toHaveCount(0);
		await dialog.getByRole("button", { name: "Close" }).click();

		const blocked = await openTask(page, blockedTitle);
		await expect(
			blocked.getByRole("textbox", { name: "Task title" }),
		).toBeDisabled();
		await blocked.getByRole("button", { name: "Delete task" }).click();
		await expect
			.poll(
				async () =>
					(await pool.query("select 1 from task where id=$1", [blockedId]))
						.rowCount,
			)
			.toBe(0);
	} finally {
		await pool.end();
	}
});

test("losing recovery authority clears confirmation and restoring it requires a new review", async ({
	page,
	browser,
}) => {
	test.setTimeout(120_000);
	const pool = testPool();
	let ownerContext: BrowserContext | null = null;
	try {
		const actorEmail = uniqueEmail("activation-member");
		const ownerEmail = uniqueEmail("activation-owner");
		await signUp(page, actorEmail);
		await waitWorkspaceReady(page);
		ownerContext = await browser.newContext({
			baseURL: new URL(page.url()).origin,
		});
		const ownerPage = await ownerContext.newPage();
		await signUp(ownerPage, ownerEmail);
		await waitWorkspaceReady(ownerPage);
		const actorId = await userId(pool, actorEmail);
		const ownerId = await userId(pool, ownerEmail);
		const workspaceId = randomUUID();
		const ownerMembershipId = randomUUID();
		const actorMembershipId = randomUUID();
		const listId = randomUUID();
		const taskId = randomUUID();
		const workspaceTitle = `Activation shared ${workspaceId.slice(0, 8)}`;
		const listTitle = `Shared review ${listId.slice(0, 8)}`;
		await pool.query(
			"insert into workspace(id,name,owner_id,kind) values($1,$2,$3,'shared')",
			[workspaceId, workspaceTitle, ownerId],
		);
		await pool.query(
			"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner'),($4,$5,$3,'member')",
			[ownerMembershipId, ownerId, workspaceId, actorMembershipId, actorId],
		);
		await pool.query(
			"insert into list(id,workspace_id,owner_id,title,kind,sort_key) values($1,$2,$3,$4,'tasks','a0')",
			[listId, workspaceId, ownerId, listTitle],
		);
		await pool.query(
			"insert into task(id,list_id,title,sort_key,due_at,reminder_time) values($1,$2,'Shared pending task','a0',now()+interval '1 day','09:00')",
			[taskId, listId],
		);
		await seedGuard(pool, {
			taskId,
			status: "pending",
			workspaceId,
			ownerId,
			ownerMembershipId,
		});
		await page
			.getByRole("button", { name: workspaceTitle, exact: true })
			.click();
		await openList(page, listTitle);
		const dialog = await openTask(page, "Shared pending task");
		const panel = dialog.getByTestId("task-import-activation");
		await panel.getByRole("button", { name: "Review task" }).click();
		await expect(panel).toContainText("Review entries: 1");
		await panel
			.getByRole("checkbox", { name: /reviewed the current recipients/i })
			.check();
		await expect(
			panel.getByRole("button", { name: "Finish import for this task" }),
		).toBeEnabled();
		await pool.query("update membership set role='viewer' where id=$1", [
			actorMembershipId,
		]);
		await expect(
			panel.getByRole("button", { name: "Review task" }),
		).toHaveCount(0);
		await expect(
			panel.getByRole("button", { name: "Finish import for this task" }),
		).toHaveCount(0);
		await expect(panel).toBeVisible();
		await expect(panel).not.toContainText("Review entries: 1");
		await expect(
			panel.getByRole("checkbox", { name: /reviewed the current recipients/i }),
		).toHaveCount(0);
		await pool.query("update membership set role='member' where id=$1", [
			actorMembershipId,
		]);
		await expect(
			panel.getByRole("button", { name: "Review task" }),
		).toBeVisible();
		await expect(panel).not.toContainText("Review entries: 1");
		await panel.getByRole("button", { name: "Review task" }).click();
		await expect(panel).toContainText("Review entries: 1");
		await expect(
			panel.getByRole("button", { name: "Finish import for this task" }),
		).toBeDisabled();
	} finally {
		await ownerContext?.close();
		await pool.end();
	}
});
