import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import {
	openDetails,
	openMoreOptions,
	sidebarLists,
	signUp,
	uniqueEmail,
} from "./helpers.ts";

test("Files and grouped dashboard tasks keep heading order on desktop and phone", async ({
	page,
}) => {
	const userId = await signUp(page, uniqueEmail("heading-order"));
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	const listId = crypto.randomUUID();
	const viewId = crypto.randomUUID();
	try {
		const workspace = await pool.query(
			"select id from workspace where owner_id=$1 and kind='personal'",
			[userId],
		);
		await pool.query(
			"insert into list (id,workspace_id,owner_id,title,kind,sort_key) values ($1,$2,$3,'Heading list','tasks','a0')",
			[listId, workspace.rows[0].id, userId],
		);
		await pool.query(
			"insert into task (id,list_id,title,priority,sort_key) values ($1,$2,'Heading task',1,'a0')",
			[crypto.randomUUID(), listId],
		);
		const filter = { op: "and", conditions: [] };
		const display = {
			layout: "list",
			groupBy: "priority",
			sort: { field: "sortKey", dir: "asc" },
			workspaceScope: { mode: "all" },
		};
		await pool.query(
			"insert into view (id,owner_id,name,filter,display,sort_key) values ($1,$2,$3,$4,$5,$6)",
			[
				viewId,
				userId,
				"Heading view",
				JSON.stringify(filter),
				JSON.stringify(display),
				"a0",
			],
		);
		await pool.query(
			"insert into dashboard (id,owner_id,name,panels,sort_key) values ($1,$2,$3,$4,$5)",
			[
				crypto.randomUUID(),
				userId,
				"Heading dashboard",
				JSON.stringify([
					{
						id: "heading-panel",
						type: "tasks",
						source: { kind: "view", viewId },
						size: "full",
					},
				]),
				"a0",
			],
		);
		await sidebarLists(page)
			.getByRole("button", { name: "Heading list", exact: true })
			.click();
		await openDetails(page, "Heading task");
		await openMoreOptions(page.getByTestId("task-detail"));
		await expect(
			page
				.getByTestId("task-attachments")
				.getByRole("heading", { name: "Files", level: 2 }),
		).toBeVisible();
		expect(
			(await new AxeBuilder({ page }).withRules(["heading-order"]).analyze())
				.violations,
		).toEqual([]);
		await page.getByTestId("task-detail-close").click();
		await page
			.getByRole("button", { name: "Heading dashboard", exact: true })
			.click();
		await expect(page.getByTestId("panel-priority-section")).toHaveCount(1);
		for (const width of [1280, 390]) {
			await page.setViewportSize({ width, height: 900 });
			await expect(
				page
					.getByTestId("panel-priority-section")
					.getByRole("heading", { level: 2 }),
			).toBeVisible();
			expect(
				(await new AxeBuilder({ page }).withRules(["heading-order"]).analyze())
					.violations,
			).toEqual([]);
		}
	} finally {
		await pool.end();
	}
});
