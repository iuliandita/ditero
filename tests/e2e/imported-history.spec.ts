import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import {
	goToSettings,
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

test("imported authors stay distinct from local people and cannot claim comment permissions", async ({
	browser,
	page,
}, testInfo) => {
	test.setTimeout(90_000);
	const databaseURL = process.env.E2E_DATABASE_URL;
	if (!databaseURL) throw new Error("E2E_DATABASE_URL is required");
	const pool = new Pool({ connectionString: databaseURL });
	const memberContext = await browser.newContext({
		baseURL: new URL(testInfo.project.use.baseURL as string).origin,
	});
	const workspaceId = randomUUID();
	const listId = randomUUID();
	const taskId = randomUUID();
	const sourceNamespace = randomUUID();
	const title = `Imported comments ${taskId.slice(0, 8)}`;
	try {
		const ownerEmail = uniqueEmail("history-owner");
		const memberEmail = uniqueEmail("history-member");
		await signUp(page, ownerEmail);
		await waitWorkspaceReady(page);
		const memberPage = await memberContext.newPage();
		await signUp(memberPage, memberEmail);
		await waitWorkspaceReady(memberPage);
		const users = await pool.query<{ id: string; email: string; name: string }>(
			'select id,email,name from "user" where email=any($1::text[])',
			[[ownerEmail, memberEmail]],
		);
		const owner = users.rows.find((row) => row.email === ownerEmail);
		const member = users.rows.find((row) => row.email === memberEmail);
		if (!owner || !member) throw new Error("Comment fixture users are missing");
		await pool.query(
			"insert into workspace(id,name,owner_id,kind) values($1,'Imported history',$2,'shared')",
			[workspaceId, owner.id],
		);
		await pool.query(
			`insert into membership(id,user_id,workspace_id,role) values
			($1,$3,$5,'owner'),($2,$4,$5,'member')`,
			[randomUUID(), randomUUID(), owner.id, member.id, workspaceId],
		);
		await pool.query(
			"insert into list(id,workspace_id,owner_id,title,kind,sort_key) values($1,$2,$3,$4,'tasks','a0')",
			[listId, workspaceId, owner.id, title],
		);
		await pool.query(
			"insert into task(id,list_id,title,sort_key) values($1,$2,'Plan the weekend','a0')",
			[taskId, listId],
		);
		const longName = `Alex ${"x".repeat(470)} \u0639\u0644\u064a`;
		for (const [name, body] of [
			[member.name, "A comment from the old workspace"],
			[longName, "A long source name stays inside the screen"],
		]) {
			await pool.query(
				`insert into comment(id,task_id,author_id,body,source_namespace,source_row_id,
				historical_author_kind,historical_author_namespace,historical_author_principal_id,
				historical_author_name,imported_at)
				values($1,$2,null,$3,$4,$1,'source_claim',$4,$5,$6,now())`,
				[randomUUID(), taskId, body, sourceNamespace, member.id, name],
			);
		}
		await pool.query(
			"insert into comment(id,task_id,author_id,body) values($1,$2,$3,'A local comment')",
			[randomUUID(), taskId, member.id],
		);
		await memberPage.reload();
		await waitWorkspaceReady(memberPage);
		await memberPage
			.getByRole("button", { name: "Imported history", exact: true })
			.click();
		await sidebarLists(memberPage)
			.getByRole("button", { name: title, exact: true })
			.click();
		await memberPage.setViewportSize({ width: 390, height: 844 });
		await memberPage
			.getByTestId("list")
			.getByText("Plan the weekend", { exact: true })
			.click();
		const thread = memberPage.getByTestId("comment-thread");
		await expect(thread.getByTestId("comment-item")).toHaveCount(3);
		for (const body of [
			"A comment from the old workspace",
			"A long source name stays inside the screen",
		]) {
			const row = thread.getByTestId("comment-item").filter({ hasText: body });
			await expect(row).toContainText("Imported author:");
			await expect(row.getByTestId("comment-edit")).toHaveCount(0);
			await expect(row.getByTestId("comment-delete")).toHaveCount(0);
			await expect(
				row.locator(':scope > span[aria-hidden="true"]'),
			).toHaveCount(0);
		}
		const local = thread
			.getByTestId("comment-item")
			.filter({ hasText: "A local comment" });
		await expect(local.getByTestId("comment-edit")).toBeVisible();
		await expect(
			local.locator(':scope > span[aria-hidden="true"]'),
		).toHaveCount(1);
		const overflow = await memberPage.evaluate(
			() =>
				Math.max(
					document.documentElement.scrollWidth,
					document.body.scrollWidth,
				) > window.innerWidth,
		);
		expect(overflow).toBe(false);
		const { violations } = await new AxeBuilder({ page: memberPage }).analyze();
		expect(
			violations.filter(
				(item) => item.impact === "serious" || item.impact === "critical",
			),
		).toEqual([]);
		await thread.scrollIntoViewIfNeeded();
		await memberPage.screenshot({
			path: testInfo.outputPath("imported-authors-mobile.png"),
			animations: "disabled",
		});
		await memberPage.keyboard.press("Escape");
		await goToSettings(memberPage);
		const response = memberPage.waitForResponse((result) =>
			result.url().endsWith("/api/portability/export"),
		);
		await memberPage.getByRole("button", { name: "Download JSON" }).click();
		expect((await response).status()).toBe(409);
		await expect(memberPage.getByRole("alert")).toContainText(
			"Use a version 2 archive",
		);
		const archive = await memberPage.request.get(
			"/api/portability/export?version=2",
		);
		expect(archive.ok()).toBe(true);
		const document = await archive.json();
		const imported = document.data.comments.filter(
			(row: { author: { kind: string } }) => row.author.kind === "source_claim",
		);
		expect(imported).toHaveLength(2);
		expect(imported[0].author.sourceNamespace).toBe(sourceNamespace);

		await page.reload();
		await waitWorkspaceReady(page);
		await page
			.getByRole("button", { name: "Imported history", exact: true })
			.click();
		await sidebarLists(page)
			.getByRole("button", { name: title, exact: true })
			.click();
		await page
			.getByTestId("list")
			.getByText("Plan the weekend", { exact: true })
			.click();
		const removable = page
			.getByTestId("comment-item")
			.filter({ hasText: "A comment from the old workspace" });
		await expect(removable.getByTestId("comment-edit")).toHaveCount(0);
		await removable.getByTestId("comment-delete").click();
		await expect(removable).toHaveCount(0);
	} finally {
		await memberContext.close();
		await pool.query("delete from task where id=$1", [taskId]);
		await pool.query("delete from list where id=$1", [listId]);
		await pool.query("delete from membership where workspace_id=$1", [
			workspaceId,
		]);
		await pool.query("delete from workspace where id=$1", [workspaceId]);
		await pool.end();
	}
});
