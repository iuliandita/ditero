import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { openShared, signUp, uniqueEmail } from "./helpers.ts";

// Two users, two browser contexts. Proves (1) workspace isolation: a list in a
// user's personal workspace never syncs to another user; (2) live sync: a task
// created/toggled in a shared workspace propagates between members.
test("workspace isolation + live task sync", async ({ browser }) => {
	const a = await browser.newContext();
	const b = await browser.newContext();
	const pa = await a.newPage();
	const pb = await b.newPage();
	const userIds: string[] = [];

	// Each context keeps its own authenticated session for the sync assertions.
	for (const [p, email] of [
		[pa, uniqueEmail("ana")],
		[pb, uniqueEmail("bob")],
	] as const) {
		userIds.push(await signUp(p, email));
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
	await pa.getByTestId("create-list-open").click();
	await pa.getByTestId("new-list").fill("Ana secret");
	await pa.getByTestId("new-list-submit").click();
	await expect(pa.getByText("Ana secret")).toBeVisible();

	// In the shared workspace, a task toggle propagates to Bob live.
	await openShared(pa);
	await openShared(pb);
	// Both have the shared list open (live query subscribed) before the write.
	// First render of the cold zero-cache view, so it gets the same budget the
	// sync assertions below already carry.
	await expect(pa.getByTestId("new-task")).toBeVisible({ timeout: 15000 });
	await expect(pb.getByTestId("new-task")).toBeVisible({ timeout: 15000 });
	// Bob's allowed list query is settled; Ana's personal list is still absent.
	await expect(pb.getByText("Ana secret")).toHaveCount(0);
	await pa.getByTestId("new-task").fill("Buy milk");
	await pa.getByTestId("new-task-submit").click();
	// Live cross-client sync: generous timeout for a cold zero-cache view.
	await expect(pb.getByText("Buy milk")).toBeVisible({ timeout: 15000 });
	// exact: the row's kebab is labelled "Actions for Buy milk", and getByLabel
	// substring-matches by default, so a loose locator now resolves to two nodes.
	await pa.getByLabel("Buy milk", { exact: true }).check();
	// Bob's row settles into his collapsed completed group once the write lands;
	// the group's count is the end state, independent of the settle timing.
	await expect(pb.getByTestId("completed-section")).toHaveText(
		/1 item completed/,
		{ timeout: 15000 },
	);
});
