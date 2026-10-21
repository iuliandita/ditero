import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import {
	openMembers,
	openWorkspaceSwitcher,
	signUp,
	switchWorkspace,
	uniqueEmail,
} from "./helpers.ts";

test.describe.configure({ timeout: 90000 });
for (const role of ["viewer", "owner"] as const) {
	test(`${role} leaves a shared workspace through their own member menu`, async ({
		page,
	}) => {
		const email = uniqueEmail(`leave-${role}`);
		const userId = await signUp(page, email);
		const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
		const workspaceId = crypto.randomUUID();
		const membershipId = crypto.randomUUID();
		try {
			const owner = await pool.query(
				'select id from "user" where id<>$1 limit 1',
				[userId],
			);
			expect(owner.rows).toHaveLength(1);
			const ownerId = owner.rows[0].id;
			await pool.query(
				"insert into workspace(id,name,owner_id,kind) values ($1,'Leave household',$2,'shared')",
				[workspaceId, role === "owner" ? userId : ownerId],
			);
			await pool.query(
				"insert into membership(id,user_id,workspace_id,role) values ($1,$2,$3,$4),($5,$6,$3,'owner')",
				[membershipId, userId, workspaceId, role, crypto.randomUUID(), ownerId],
			);
			await switchWorkspace(page, "Leave household");
			await openMembers(page);
			const ownRow = page
				.getByTestId("member-row")
				.filter({ hasText: email.split("@")[0] });
			await ownRow.getByTestId("row-actions").click();
			await page.getByTestId("row-action-leave").click();
			const dialog = page.getByTestId("confirm-dialog");
			await expect(dialog).toContainText("lose access");
			await expect(dialog).toContainText("assignments will be removed");
			await expect(dialog).toContainText("key rotation");
			await page.getByTestId("confirm-accept").click();
			await expect(page.getByTestId("members-panel")).toHaveCount(0);
			await expect
				.poll(
					async () =>
						(
							await pool.query("select 1 from membership where id=$1", [
								membershipId,
							])
						).rowCount,
				)
				.toBe(0);
			expect(
				(
					await pool.query(
						"select rotation_required from workspace where id=$1",
						[workspaceId],
					)
				).rows[0].rotation_required,
			).toBe(true);
			await openWorkspaceSwitcher(page);
			await expect(
				page
					.getByTestId("workspace-option")
					.filter({ hasText: "Leave household" }),
			).toHaveCount(0);
			await expect(
				page.locator(
					'[data-testid="workspace-option"][data-workspace-kind="personal"]',
				),
			).toHaveCount(1);
		} finally {
			await pool.end();
		}
	});
}

test("the sole owner sees a disabled Leave action with the transfer reason", async ({
	page,
}) => {
	const email = uniqueEmail("leave-sole");
	const userId = await signUp(page, email);
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		const workspaceId = crypto.randomUUID();
		await pool.query(
			"insert into workspace(id,name,owner_id,kind) values ($1,'Sole household',$2,'shared')",
			[workspaceId, userId],
		);
		await pool.query(
			"insert into membership(id,user_id,workspace_id,role) values ($1,$2,$3,'owner')",
			[crypto.randomUUID(), userId, workspaceId],
		);
		await switchWorkspace(page, "Sole household");
		await openMembers(page);
		await page.getByTestId("member-row").getByTestId("row-actions").click();
		await expect(page.getByTestId("row-action-leave")).toHaveAttribute(
			"aria-disabled",
			"true",
		);
		await expect(page.getByTestId("row-action-leave")).toContainText(
			"Transfer ownership",
		);
	} finally {
		await pool.end();
	}
});
