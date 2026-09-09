import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import { m } from "../../src/paraglide/messages.js";
import {
	goToSettings,
	leaveSettings,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

test.describe.configure({ timeout: 120_000 });

const PASSPHRASE = "correct horse battery staple";
const DERIVE_TIMEOUT = 30_000;

async function expectNoSeriousA11y(page: Page, surface: string): Promise<void> {
	await page.addStyleTag({
		content:
			"*,*::before,*::after{animation:none!important;transition:none!important}",
	});
	const { violations } = await new AxeBuilder({ page }).analyze();
	const serious = violations.filter(
		(violation) =>
			violation.impact === "serious" || violation.impact === "critical",
	);
	expect(serious, `serious/critical a11y violations on ${surface}`).toEqual([]);
}

async function createListAndTask(
	page: Page,
	listName: string,
	taskName: string,
): Promise<void> {
	await waitWorkspaceReady(page);
	await page.getByTestId("new-list").fill(listName);
	await page.getByTestId("new-list-submit").click();
	await page
		.locator('nav[aria-label="Lists"]')
		.getByRole("button", { name: listName, exact: true })
		.first()
		.click();
	await expect(page.getByTestId("new-task")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("new-task").fill(taskName);
	await page.getByTestId("new-task-submit").click();
	await page
		.getByTestId("list")
		.getByRole("button", { name: taskName, exact: true })
		.click();
	await expect(
		page.getByRole("dialog", { name: m.task_detail_title() }),
	).toBeVisible();
}

function inputFor(scope: Locator): Locator {
	return scope
		.locator("xpath=ancestor::fieldset")
		.getByTestId("attachment-input");
}

async function finishEnrollment(
	page: Page,
	filename?: string,
	acceptingInvite = false,
): Promise<void> {
	await expect(page.getByTestId("e2e-enroll-dialog")).toBeVisible();
	await page.getByTestId("e2e-passphrase").fill(PASSPHRASE);
	await page.getByTestId("e2e-passphrase-confirm").fill(PASSPHRASE);
	await page.getByTestId("e2e-enroll-continue").click();
	const recovery = page.getByTestId("e2e-recovery-code");
	await expect(recovery).toBeVisible({ timeout: DERIVE_TIMEOUT });
	const code = (await recovery.innerText()).replace(/\s+/g, "-");
	await page.getByTestId("e2e-recovery-confirm").fill(code);
	await page.getByTestId("e2e-recovery-submit").click();
	if (acceptingInvite) {
		await expect(page.getByTestId("workspace")).toBeVisible({
			timeout: DERIVE_TIMEOUT,
		});
		return;
	}
	if (filename) {
		await expect(page.getByTestId("e2e-enroll-pending-upload")).toContainText(
			filename,
			{ timeout: DERIVE_TIMEOUT },
		);
	}
	await page.getByTestId("e2e-enroll-close").click();
	await expect(page.getByTestId("e2e-enroll-dialog")).toHaveCount(0, {
		timeout: DERIVE_TIMEOUT,
	});
}

test("attachments render on task, comment, and list surfaces", async ({
	page,
}) => {
	const stamp = `${Date.now()}`;
	const listName = `Files ${stamp}`;
	const taskName = `Attach ${stamp}`;
	await signUp(page, uniqueEmail("attachments-ui"));
	await createListAndTask(page, listName, taskName);

	const taskSurface = page.getByTestId("task-attachments");
	await expect(taskSurface.getByText(m.attachment_empty())).toBeVisible();
	await inputFor(taskSurface).setInputFiles({
		name: "discarded.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("discarded before enrollment"),
	});
	await expect(page.getByTestId("e2e-enroll-dialog")).toBeVisible();
	await page.getByTestId("e2e-enroll-cancel").click();
	await expect(page.getByText(m.e2e_enroll_discard_notice())).toBeVisible();
	await expect(taskSurface.getByText("discarded.txt")).toHaveCount(0);
	await inputFor(taskSurface).setInputFiles({
		name: "task-note.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("task attachment plaintext"),
	});
	await finishEnrollment(page, "task-note.txt");
	await expect(
		taskSurface.getByRole("listitem").filter({ hasText: "task-note.txt" }),
	).toBeVisible({
		timeout: 20_000,
	});
	await expect(
		taskSurface.getByRole("button", { name: /Cancel upload/ }),
	).toHaveCount(0, { timeout: 20_000 });
	await expectNoSeriousA11y(page, "task attachments");

	const composer = page.getByTestId("comment-input");
	await inputFor(composer).setInputFiles({
		name: "comment-note.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("comment attachment plaintext"),
	});
	await expect(page.getByText(m.attachment_ready_to_upload())).toBeVisible();
	await expect(page.getByTestId("comment-attachments")).toHaveCount(0);
	await composer.fill("Attached for context");
	await page.getByTestId("comment-submit").click();
	const comment = page
		.getByTestId("comment-item")
		.filter({ hasText: "Attached for context" });
	await expect(
		comment.getByRole("listitem").filter({ hasText: "comment-note.txt" }),
	).toBeVisible({
		timeout: 20_000,
	});
	await expectNoSeriousA11y(page, "comment attachments");
	const commentTile = comment
		.getByRole("listitem")
		.filter({ hasText: "comment-note.txt" });
	await commentTile.getByTestId("row-actions").click();
	await page.getByTestId("row-action-delete").click();
	await page.getByTestId("confirm-accept").click();
	await expect(commentTile).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: m.attachment_add_to_comment() }),
	).toBeFocused();

	const taskTile = taskSurface
		.getByRole("listitem")
		.filter({ hasText: "task-note.txt" });
	await taskTile.getByTestId("row-actions").click();
	await page.getByTestId("row-action-delete").click();
	await page.getByTestId("confirm-accept").click();
	await expect(taskTile).toHaveCount(0);
	await expect(
		taskSurface
			.locator("xpath=ancestor::fieldset")
			.getByRole("button", { name: m.attachment_add() }),
	).toBeFocused();

	const detail = page.getByRole("dialog", { name: m.task_detail_title() });
	await detail.getByRole("button", { name: m.modal_close_label() }).click();
	await expect(detail).toBeHidden();

	const listHeaderMenu = page
		.getByTestId("list")
		.getByTestId("row-actions")
		.first();
	const fileChooser = page.waitForEvent("filechooser");
	await listHeaderMenu.click();
	await page.getByTestId("row-action-attachment-add").click();
	await (await fileChooser).setFiles({
		name: "list-image.png",
		mimeType: "image/png",
		buffer: Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		),
	});
	const listFiles = page.getByTestId("list-attachments");
	await expect(listFiles).toBeVisible({ timeout: 20_000 });
	await listFiles.locator("summary").click();
	await expect(
		listFiles.getByRole("img", {
			name: m.attachment_thumbnail_alt({ name: "list-image.png" }),
		}),
	).toBeVisible({ timeout: 20_000 });
	const stagedUploads = await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) {
			if (name.startsWith("ditero-upload-")) names.push(name);
		}
		return names;
	});
	expect(stagedUploads).toEqual([]);
	await expectNoSeriousA11y(page, "list attachments");
	const listTile = listFiles
		.getByRole("listitem")
		.filter({ hasText: "list-image.png" });
	await listTile.getByTestId("row-actions").click();
	await page.getByTestId("row-action-delete").click();
	await page.getByTestId("confirm-accept").click();
	await expect(listTile).toHaveCount(0);
	await expect(listHeaderMenu).toBeFocused();
});

async function closeTask(page: Page): Promise<void> {
	const detail = page.getByRole("dialog", { name: m.task_detail_title() });
	await detail.getByRole("button", { name: m.modal_close_label() }).click();
	await expect(detail).toBeHidden();
}

async function openTask(page: Page, listName: string, taskName: string) {
	await page
		.locator('nav[aria-label="Lists"]')
		.getByRole("button", { name: listName, exact: true })
		.first()
		.click();
	await page
		.getByTestId("list")
		.getByRole("button", { name: taskName, exact: true })
		.click();
	await expect(page.getByTestId("task-attachments")).toBeVisible();
}

async function createInvite(page: Page, email: string): Promise<URL> {
	await page.getByTestId("open-members").click();
	await page.getByTestId("invite-open").click();
	await page.getByTestId("invite-email").fill(email);
	await page.getByTestId("invite-submit").click();
	await expect(page.getByTestId("invite-link")).toBeVisible();
	const link = new URL(await page.getByTestId("invite-link").inputValue());
	await page.keyboard.press("Escape");
	await page
		.getByTestId("members-panel")
		.getByRole("button", { name: m.modal_close_label() })
		.click();
	await expect(page.getByTestId("members-panel")).toBeHidden();
	return link;
}

async function expectDownload(page: Page, name: string, plaintext: Buffer) {
	const tile = page
		.getByTestId("task-attachments")
		.getByRole("listitem")
		.filter({ hasText: name });
	await expect(tile).toBeVisible({ timeout: 20_000 });
	await tile.getByTestId("row-actions").click();
	const downloading = page.waitForEvent("download");
	await page.getByTestId("row-action-download").click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe(name);
	const path = await download.path();
	expect(path).not.toBeNull();
	expect(await readFile(path as string)).toEqual(plaintext);
}

test("attachment canary: ciphertext, fragment grant, removal, rotation, and pending access", async ({
	browser,
}) => {
	test.setTimeout(180_000);
	const ownerContext = await browser.newContext();
	const memberContext = await browser.newContext();
	const outsiderContext = await browser.newContext();
	const owner = await ownerContext.newPage();
	const member = await memberContext.newPage();
	const outsider = await outsiderContext.newPage();
	for (const page of [owner, member, outsider]) page.setDefaultTimeout(20_000);
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		const stamp = `${Date.now()}`;
		const listName = `Canary files ${stamp}`;
		const taskName = `Canary task ${stamp}`;
		const memberEmail = uniqueEmail("canary-member");
		const outsiderEmail = uniqueEmail("canary-outsider");
		const ownerEmail = uniqueEmail("canary-owner");
		const workspaceName = `Canary household ${stamp}`;
		const oldName = `private-before-${stamp}.txt`;
		const newName = `private-after-${stamp}.txt`;
		const oldBytes = Buffer.from(`Confidential original attachment ${stamp}`);
		const newBytes = Buffer.from(`Confidential rotated attachment ${stamp}`);
		await signUp(owner, ownerEmail);
		// Workspace creation has no UI yet. Only this fixture is seeded; keys,
		// files, invitations, membership removal, and rotation use real UI flows.
		const workspaceId = `w_canary_${stamp}`;
		const ownerId = (
			await pool.query<{ id: string }>(
				'select id from "user" where email = $1',
				[ownerEmail],
			)
		).rows[0].id;
		await pool.query(
			"insert into workspace (id, name, owner_id, kind) values ($1, $2, $3, 'shared')",
			[workspaceId, workspaceName, ownerId],
		);
		await pool.query(
			"insert into membership (id, user_id, workspace_id, role) values ($1, $2, $3, 'owner')",
			[`m_canary_${stamp}`, ownerId, workspaceId],
		);
		await owner
			.getByRole("button", { name: workspaceName, exact: true })
			.click();
		await createListAndTask(owner, listName, taskName);
		const committed = owner.waitForResponse("**/api/attachments/finalize");
		await inputFor(owner.getByTestId("task-attachments")).setInputFiles({
			name: oldName,
			mimeType: "text/plain",
			buffer: oldBytes,
		});
		await finishEnrollment(owner, oldName);
		const finalized = await committed;
		expect(finalized.ok()).toBe(true);
		const { id: oldId } = (await finalized.json()) as { id: string };
		const stored = await pool.query<{
			storage_key: string;
			key_version: number;
			filename_ciphertext: string;
		}>(
			"select storage_key, key_version, filename_ciphertext from attachment where id = $1 and state = 'committed'",
			[oldId],
		);
		expect(stored.rowCount).toBe(1);
		const ciphertext = await readFile(
			resolve("data/attachments", stored.rows[0].storage_key),
		);
		expect(ciphertext.length).toBeGreaterThan(oldBytes.length);
		expect(ciphertext.includes(oldBytes)).toBe(false);
		expect(stored.rows[0].filename_ciphertext).not.toContain(oldName);
		await expectDownload(owner, oldName, oldBytes);
		await expect(
			owner
				.getByTestId("task-attachments")
				.locator("xpath=ancestor::fieldset")
				.getByRole("button", { name: m.attachment_add(), exact: true }),
		).toBeVisible();
		await closeTask(owner);

		const link = await createInvite(owner, memberEmail);
		expect(new URLSearchParams(link.hash.slice(1)).get("e2e")).toBeTruthy();
		await member.goto(`${link.pathname}${link.search}${link.hash}`);
		await member.getByTestId("accept-email").fill(memberEmail);
		await member.getByTestId("accept-password").fill("pw-123456");
		await member.getByTestId("accept-submit").click();
		await finishEnrollment(member, undefined, true);
		await member
			.getByRole("button", { name: workspaceName, exact: true })
			.click();
		await openTask(member, listName, taskName);
		await expectDownload(member, oldName, oldBytes);

		await signUp(outsider, outsiderEmail);
		const oldUrl = `/api/attachments/${encodeURIComponent(oldId)}/download`;
		expect((await outsider.request.get(oldUrl)).status()).toBe(403);
		await goToSettings(outsider);
		await outsider.getByTestId("e2e-setup").click();
		await finishEnrollment(outsider);

		await owner.getByTestId("open-members").click();
		const memberRow = owner
			.getByTestId("member-row")
			.filter({ hasText: memberEmail.split("@")[0] });
		await expect(memberRow).toBeVisible();
		await memberRow.getByTestId("row-actions").click();
		await owner.getByTestId("row-action-remove").click();
		await owner.getByTestId("confirm-accept").click();
		await expect(memberRow).toHaveCount(0);
		await owner
			.getByTestId("members-panel")
			.getByRole("button", { name: m.modal_close_label() })
			.click();
		await openTask(owner, listName, taskName);
		const blocked = owner
			.getByTestId("task-attachments")
			.locator("xpath=ancestor::fieldset")
			.getByTestId("attachment-rotation-blocked");
		await expect(blocked).toBeVisible();
		await expect(blocked).toContainText(m.e2e_rotation_blocked_title());
		await expect(
			owner
				.getByTestId("task-attachments")
				.locator("xpath=ancestor::fieldset")
				.getByRole("button", { name: m.attachment_add(), exact: true }),
		).toHaveCount(0);
		await expectNoSeriousA11y(owner, "rotation required");
		await blocked
			.getByRole("button", { name: m.e2e_rotation_action() })
			.click();
		await owner
			.getByTestId("attachment-rotation-dialog")
			.getByRole("button", { name: m.e2e_rotation_confirm_submit() })
			.click();
		await expect(blocked).toHaveCount(0, { timeout: 20_000 });
		await expectDownload(owner, oldName, oldBytes);
		const newCommitted = owner.waitForResponse("**/api/attachments/finalize");
		await inputFor(owner.getByTestId("task-attachments")).setInputFiles({
			name: newName,
			mimeType: "text/plain",
			buffer: newBytes,
		});
		const newFinalized = await newCommitted;
		expect(newFinalized.ok()).toBe(true);
		const { id: newId } = (await newFinalized.json()) as { id: string };
		await expectDownload(owner, newName, newBytes);
		const rotated = await pool.query<{ key_version: number }>(
			"select key_version from attachment where id = $1",
			[newId],
		);
		expect(rotated.rows[0].key_version).toBe(stored.rows[0].key_version + 1);
		expect((await member.request.get(oldUrl)).status()).toBe(403);
		expect(
			(
				await member.request.get(
					`/api/attachments/${encodeURIComponent(newId)}/download`,
				)
			).status(),
		).toBe(403);

		await closeTask(owner);
		const pendingLink = await createInvite(owner, outsiderEmail);
		await goToSettings(owner);
		await owner.getByTestId("e2e-lock-now").click();
		await expect(owner.getByTestId("e2e-status")).toHaveText(
			m.e2e_status_locked(),
		);
		await leaveSettings(outsider);
		await outsider.goto(
			`/accept?token=${encodeURIComponent(pendingLink.searchParams.get("token") as string)}`,
		);
		await outsider.getByTestId("accept-join").click();
		await expect(outsider.getByTestId("workspace")).toBeVisible();
		await outsider
			.getByRole("button", { name: workspaceName, exact: true })
			.click();
		await openTask(outsider, listName, taskName);
		const pending = outsider.getByTestId("task-attachments");
		await expect(
			pending.getByText(m.attachment_key_pending()).first(),
		).toBeVisible();
		await expect(pending).not.toContainText(oldName);
		await expect(pending).not.toContainText(newName);
		await expectNoSeriousA11y(outsider, "pending attachment keys");
	} catch (error) {
		await test.info().attach("owner-surface", {
			body: await owner.locator("body").innerText(),
			contentType: "text/plain",
		});
		throw error;
	} finally {
		await pool.end();
		await ownerContext.close();
		await memberContext.close();
		await outsiderContext.close();
	}
});
