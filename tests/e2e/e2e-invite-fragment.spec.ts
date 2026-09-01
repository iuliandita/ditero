import { expect, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import { goToSettings, signUp, uniqueEmail } from "./helpers.ts";

const WORKSPACE = "w_shared_e2e";
const PASSWORD = "pw-123456";
const PASSPHRASE = "correct horse battery staple";
const DERIVE_TIMEOUT = 30_000;

async function userId(page: Page): Promise<string> {
	return await page.evaluate(async () => {
		const response = await fetch("/api/auth/get-session");
		const session = (await response.json()) as { user: { id: string } };
		return session.user.id;
	});
}

async function joinShared(id: string, role: "owner" | "member" = "member") {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await pool.query(
			`insert into membership (id, user_id, workspace_id, role)
			 values ($1, $2, $3, $4)`,
			[`m_${crypto.randomUUID()}`, id, WORKSPACE, role],
		);
	} finally {
		await pool.end();
	}
}

async function enroll(page: Page, fromSettings: boolean): Promise<void> {
	if (fromSettings) {
		await goToSettings(page);
		await page.getByTestId("e2e-setup").click();
	}
	await expect(page.getByTestId("e2e-enroll-dialog")).toBeVisible({
		timeout: DERIVE_TIMEOUT,
	});
	await page.getByTestId("e2e-passphrase").fill(PASSPHRASE);
	await page.getByTestId("e2e-passphrase-confirm").fill(PASSPHRASE);
	await page.getByTestId("e2e-enroll-continue").click();
	const code = page.getByTestId("e2e-recovery-code");
	await expect(code).toBeVisible({ timeout: DERIVE_TIMEOUT });
	await page
		.getByTestId("e2e-recovery-confirm")
		.fill((await code.innerText()).replace(/\s+/g, "-"));
	await page.getByTestId("e2e-recovery-submit").click();
	if (fromSettings) {
		await expect(page.getByTestId("e2e-enroll-close")).toBeVisible({
			timeout: DERIVE_TIMEOUT,
		});
		await page.getByTestId("e2e-enroll-close").click();
	}
}

async function openShared(page: Page): Promise<void> {
	await expect(page.getByTestId("open-shared")).toBeVisible({
		timeout: 20_000,
	});
	await page.getByTestId("open-shared").click();
	await expect(page.getByTestId("open-members")).toBeVisible({
		timeout: 20_000,
	});
}

async function invite(page: Page, email: string): Promise<string> {
	await page.getByTestId("open-members").click();
	await page.getByTestId("invite-open").click();
	await page.getByTestId("invite-email").fill(email);
	await page.getByTestId("invite-submit").click();
	const input = page.getByTestId("invite-link");
	await expect(input).toBeVisible({ timeout: 20_000 });
	const link = await input.inputValue();
	await page.keyboard.press("Escape");
	await page
		.getByTestId("members-panel")
		.getByRole("button", { name: "Close" })
		.click();
	return link;
}

test("fragment invite survives reload ordering and retains the async fallback", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const ownerContext = await browser.newContext();
	const fastContext = await browser.newContext();
	const fallbackContext = await browser.newContext();
	const owner = await ownerContext.newPage();
	const newcomer = await fastContext.newPage();
	const fallback = await fallbackContext.newPage();
	const keyringErrors: string[] = [];
	for (const page of [owner, newcomer, fallback]) {
		page.on("console", (message) => {
			if (
				message.type() === "error" &&
				(message.text().includes("e2e: workspace key refresh failed") ||
					message.text() === "TypeError: Failed to fetch")
			) {
				keyringErrors.push(message.text());
			}
		});
	}
	const ownerEmail = uniqueEmail("fragment-owner");
	const newcomerEmail = uniqueEmail("fragment-new");
	const fallbackEmail = uniqueEmail("fragment-fallback");

	await signUp(owner, ownerEmail);
	await joinShared(await userId(owner), "owner");
	await enroll(owner, true);
	await openShared(owner);

	const fastLink = new URL(await invite(owner, newcomerEmail));
	expect(fastLink.searchParams.get("e2e")).toBeTruthy();
	expect(new URLSearchParams(fastLink.hash.slice(1)).get("e2e")).toBeTruthy();
	const token = fastLink.searchParams.get("token");
	expect(token).toBeTruthy();

	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		// Preview is deliberately inert: no reservation and no use is consumed.
		const preview = await newcomer.request.get(
			`/api/invite/preview?token=${encodeURIComponent(token as string)}`,
		);
		expect(preview.ok()).toBe(true);
		const before = await pool.query(
			"select uses, claimed_by from invite where token = $1",
			[token],
		);
		expect(before.rows[0]).toEqual({ uses: 0, claimed_by: null });

		let finalizeCalls = 0;
		let interruptedFinalizes = 0;
		await newcomer.route("**/api/invite/finalize", async (route) => {
			finalizeCalls += 1;
			const durable = await pool.query(
				`select 1 from membership_key mk
				 join invite i on i.workspace_id = mk.workspace_id
				 where i.token = $1 and mk.user_id = i.claimed_by`,
				[token],
			);
			if (durable.rowCount === 1 && interruptedFinalizes === 0) {
				interruptedFinalizes += 1;
				await route.abort("failed");
			} else await route.continue();
		});
		await newcomer.goto(
			`${fastLink.pathname}${fastLink.search}${fastLink.hash}`,
		);
		await expect(newcomer.getByTestId("accept-page")).toBeVisible();
		await expect.poll(() => newcomer.url()).not.toContain("#");
		await newcomer.getByTestId("accept-email").fill(newcomerEmail);
		await newcomer.getByTestId("accept-password").fill(PASSWORD);
		await newcomer.getByTestId("accept-submit").click();
		await enroll(newcomer, false);

		// The finalize after the durable self-grant is the first one worth trying.
		// Dropping it simulates a reload in the exact gap the ordering exists to save.
		await expect
			.poll(() => interruptedFinalizes, { timeout: DERIVE_TIMEOUT })
			.toBe(1);
		expect(finalizeCalls).toBe(1);
		await expect
			.poll(
				async () =>
					(
						await pool.query(
							`select count(*)::int as count from membership_key mk
							 join invite i on i.workspace_id = mk.workspace_id
							 where i.token = $1 and mk.user_id = i.claimed_by`,
							[token],
						)
					).rows[0]?.count,
				{ timeout: DERIVE_TIMEOUT },
			)
			.toBe(1);
		const interrupted = await pool.query(
			"select uses, status from invite where token = $1",
			[token],
		);
		expect(interrupted.rows[0]).toEqual({ uses: 0, status: "pending" });

		await newcomer.reload();
		await expect(newcomer.getByTestId("workspace")).toBeVisible({
			timeout: DERIVE_TIMEOUT,
		});
		expect(finalizeCalls).toBeGreaterThanOrEqual(2);
		const accepted = await pool.query(
			"select uses, status from invite where token = $1",
			[token],
		);
		expect(accepted.rows[0]).toEqual({ uses: 1, status: "accepted" });

		// Reusing the link is idempotent for its claimant and does not manufacture
		// a second request or wrap.
		await newcomer.goto(
			`${fastLink.pathname}${fastLink.search}${fastLink.hash}`,
		);
		await expect(newcomer.getByTestId("workspace")).toBeVisible({
			timeout: DERIVE_TIMEOUT,
		});
		const counts = await pool.query(
			`select
			 (select count(*)::int from membership_key mk
			  join invite i on i.workspace_id = mk.workspace_id
			  where i.token = $1 and mk.user_id = i.claimed_by) as keys,
			 (select count(*)::int from key_grant_request r
			  join invite i on i.workspace_id = r.workspace_id
			  where i.token = $1 and r.user_id = i.claimed_by) as requests`,
			[token],
		);
		expect(counts.rows[0]).toEqual({ keys: 1, requests: 1 });

		// The same kind of generated invite, with its fragment deliberately
		// omitted, takes the original async path and leaves a pending grant.
		const fallbackLink = new URL(await invite(owner, fallbackEmail));
		await fallback.goto(
			`/accept?token=${encodeURIComponent(fallbackLink.searchParams.get("token") as string)}`,
		);
		await fallback.getByTestId("accept-email").fill(fallbackEmail);
		await fallback.getByTestId("accept-password").fill(PASSWORD);
		await fallback.getByTestId("accept-submit").click();
		await expect(fallback.getByTestId("workspace")).toBeVisible({
			timeout: DERIVE_TIMEOUT,
		});
		const pending = await pool.query(
			`select r.state from key_grant_request r
			 join invite i on i.workspace_id = r.workspace_id
			 join "user" u on u.id = r.user_id
			 where i.token = $1 and u.email = $2`,
			[fallbackLink.searchParams.get("token"), fallbackEmail],
		);
		expect(pending.rows).toEqual([{ state: "key_pending" }]);
		expect(keyringErrors).toEqual([]);
	} finally {
		await pool.end();
		await ownerContext.close();
		await fastContext.close();
		await fallbackContext.close();
	}
});
