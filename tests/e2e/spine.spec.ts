import { expect, test } from "@playwright/test";
import { Pool } from "pg";

// Two users, two browser contexts. Proves (1) workspace isolation: a list in a
// user's personal workspace never syncs to another user; (2) live sync: a task
// created/toggled in a shared workspace propagates between members.
test("workspace isolation + live task sync", async ({ browser }) => {
	const a = await browser.newContext();
	const b = await browser.newContext();
	const pa = await a.newPage();
	const pb = await b.newPage();
	const userIds: string[] = [];

	// Sign up two users. Signup (email verification off) yields an active session.
	for (const [p, email] of [
		[pa, "ana@t.dev"],
		[pb, "bob@t.dev"],
	] as const) {
		await p.goto("/");
		await p.getByTestId("email").fill(email);
		await p.getByTestId("password").fill("pw-123456");
		await p.getByTestId("signup").click();
		await expect(p.getByTestId("workspace")).toBeVisible();
		const session = await p.evaluate(async () => {
			const response = await fetch("/api/auth/get-session");
			return (await response.json()) as { user: { id: string } };
		});
		userIds.push(session.user.id);
	}

	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		const keys = await pool.query<{ private_key: string }>(
			"select private_key from jwks",
		);
		expect(keys.rows[0]?.private_key).toMatch(/^ditero:v1:/);
		for (const userId of userIds) {
			await pool.query(
				`insert into membership (id, user_id, workspace_id, role)
				 values ($1, $2, $3, 'member')`,
				[crypto.randomUUID(), userId, "w_shared_e2e"],
			);
		}
	} finally {
		await pool.end();
	}

	// Ana creates a list in her personal workspace -> Bob must never see it.
	await pa.getByTestId("new-list").fill("Ana secret");
	await pa.getByTestId("new-list-submit").click();
	await expect(pa.getByText("Ana secret")).toBeVisible();

	// In the shared workspace, a task toggle propagates to Bob live.
	await pa.getByTestId("open-shared").click();
	await pb.getByTestId("open-shared").click();
	// Both have the shared list open (live query subscribed) before the write.
	await expect(pa.getByTestId("new-task")).toBeVisible();
	await expect(pb.getByTestId("new-task")).toBeVisible();
	// Bob's allowed list query is settled; Ana's personal list is still absent.
	await expect(pb.getByText("Ana secret")).toHaveCount(0);
	await pa.getByTestId("new-task").fill("Buy milk");
	await pa.getByTestId("new-task-submit").click();
	// Live cross-client sync: generous timeout for a cold zero-cache view.
	await expect(pb.getByText("Buy milk")).toBeVisible({ timeout: 15000 });
	// exact: the row's kebab is labelled "Actions for Buy milk", and getByLabel
	// substring-matches by default, so a loose locator now resolves to two nodes.
	await pa.getByLabel("Buy milk", { exact: true }).check();
	await expect(pb.getByLabel("Buy milk", { exact: true })).toBeChecked({
		timeout: 15000,
	});
});
