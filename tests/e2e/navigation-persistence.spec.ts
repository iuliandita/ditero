import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import {
	sidebarLists,
	signUp,
	switchWorkspace,
	uniqueEmail,
} from "./helpers.ts";

test("reload restores the account's shared workspace/list and falls back after access is lost", async ({
	page,
}) => {
	const userId = await signUp(page, uniqueEmail("last-navigation"));
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	const workspaceId = crypto.randomUUID();
	const listId = crypto.randomUUID();
	try {
		await pool.query(
			"insert into workspace (id,name,owner_id,kind) values ($1,'Navigation shared',$2,'shared')",
			[workspaceId, userId],
		);
		await pool.query(
			"insert into membership (id,workspace_id,user_id,role) values ($1,$2,$3,'owner')",
			[crypto.randomUUID(), workspaceId, userId],
		);
		await pool.query(
			"insert into list (id,workspace_id,owner_id,title,kind,sort_key) values ($1,$2,$3,'Navigation list','tasks','a0')",
			[listId, workspaceId, userId],
		);
		await switchWorkspace(page, "Navigation shared");
		await sidebarLists(page)
			.getByRole("button", { name: "Navigation list", exact: true })
			.click();
		await expect(
			page
				.getByTestId("list")
				.getByRole("heading", { level: 1, name: "Navigation list" }),
		).toBeVisible();
		await page.reload();
		await expect(page.getByTestId("workspace-switcher")).toContainText(
			"Navigation shared",
		);
		await expect(
			page
				.getByTestId("list")
				.getByRole("heading", { level: 1, name: "Navigation list" }),
		).toBeVisible();
		await pool.query("delete from list where id=$1", [listId]);
		await expect(page.getByTestId("list")).toHaveCount(0);
		await page.reload();
		await expect(page.getByTestId("workspace-switcher")).toContainText(
			"Navigation shared",
		);
		await expect(page.getByTestId("list")).toHaveCount(0);
		await pool.query(
			"delete from membership where workspace_id=$1 and user_id=$2",
			[workspaceId, userId],
		);
		await expect(page.getByTestId("workspace-switcher")).not.toContainText(
			"Navigation shared",
		);
		await page.reload();
		await expect(page.getByTestId("workspace-switcher")).toContainText(
			"'s space",
		);
		await expect(page.getByTestId("list")).toHaveCount(0);
	} finally {
		await pool.end();
	}
});
