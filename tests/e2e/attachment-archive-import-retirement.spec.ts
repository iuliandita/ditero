import { type Download, expect, type Page, test } from "@playwright/test";
import type { PortableExportV2 } from "../../src/domain/portability/v2.ts";
import { m } from "../../src/paraglide/messages.js";
import {
	chooseOption,
	goToSettings,
	openDetails,
	openMoreOptions,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

const ACCOUNT_SECRET = "correct horse battery staple";
const ARCHIVE_SECRET = "separate fictional migration secret";
const FILE_NAME = "household-note.txt";
const PLAINTEXT = "Fictional household attachment migration payload";
const DERIVE_TIMEOUT = 30_000;
async function readDownload(download: Download) {
	const parts: Buffer[] = [];
	for await (const part of await download.createReadStream())
		parts.push(Buffer.from(part));
	return Buffer.concat(parts);
}
async function enroll(page: Page) {
	await expect(page.getByTestId("e2e-enroll-dialog")).toBeVisible();
	await page.getByTestId("e2e-passphrase").fill(ACCOUNT_SECRET);
	await page.getByTestId("e2e-passphrase-confirm").fill(ACCOUNT_SECRET);
	await page.getByTestId("e2e-enroll-continue").click();
	const recovery = page.getByTestId("e2e-recovery-code");
	await expect(recovery).toBeVisible({ timeout: DERIVE_TIMEOUT });
	await page
		.getByTestId("e2e-recovery-confirm")
		.fill((await recovery.innerText()).replace(/\s+/g, "-"));
	await page.getByTestId("e2e-recovery-submit").click();
	await page.getByTestId("e2e-enroll-close").click({ timeout: DERIVE_TIMEOUT });
	await expect(page.getByTestId("e2e-enroll-dialog")).toHaveCount(0);
}
async function capture(page: Page, name: string) {
	const path = test.info().outputPath(`${name}.png`);
	await page.screenshot({ path, fullPage: false });
	await test.info().attach(name, { path, contentType: "image/png" });
}

test("archive import retires prepared file metadata after real keyring expiry", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await page.clock.install({ time: new Date() });
	await page.setViewportSize({ width: 1440, height: 1000 });
	await signUp(page, uniqueEmail("archive-import"));
	await waitWorkspaceReady(page);
	const listTitle = `Migration household ${Date.now()}`;
	const taskTitle = "Keep the household attachment";
	await page.getByTestId("create-list-open").click();
	await page.getByTestId("new-list").fill(listTitle);
	await page.getByTestId("new-list-submit").click();
	await page
		.locator('nav[aria-label="Lists"]')
		.getByRole("button", { name: listTitle, exact: true })
		.first()
		.click();
	await page.getByTestId("new-task").fill(taskTitle);
	await page.getByTestId("new-task-submit").click();
	await openDetails(page, taskTitle);
	const detail = page.getByRole("dialog", { name: m.task_detail_title() });
	await openMoreOptions(detail);
	const uploaded = page.waitForResponse("**/api/attachments/finalize");
	await page
		.getByTestId("task-attachments")
		.locator("xpath=ancestor::fieldset")
		.getByTestId("attachment-input")
		.setInputFiles({
			name: FILE_NAME,
			mimeType: "text/plain",
			buffer: Buffer.from(PLAINTEXT),
		});
	await enroll(page);
	expect((await uploaded).ok()).toBe(true);
	await expect(
		page.getByTestId("task-attachments").getByRole("button", {
			name: m.attachment_open_named({ name: FILE_NAME }),
			exact: true,
		}),
	).toBeVisible({ timeout: 20_000 });
	await detail.getByRole("button", { name: m.modal_close_label() }).click();
	await expect(detail).toHaveCount(0);
	await goToSettings(page);
	await page.getByTestId("theme-switcher").click();
	await page.getByRole("option", { name: "Light", exact: true }).click();
	const contentResponse = page
		.waitForResponse("**/api/portability/export?version=2")
		.then(async (response) => {
			expect(response.ok()).toBe(true);
			return await response.text();
		});
	await page
		.getByRole("button", { name: "Export selected files", exact: true })
		.click();
	const exporter = page.getByTestId("attachment-archive-export-dialog");
	await exporter
		.getByRole("checkbox", { name: FILE_NAME, exact: true })
		.check({ timeout: DERIVE_TIMEOUT });
	const exactExportedContent = await contentResponse;
	const fields = exporter.locator('input[type="password"]');
	await fields.nth(0).fill(ARCHIVE_SECRET);
	await fields.nth(1).fill(ARCHIVE_SECRET);
	await exporter
		.getByRole("button", { name: "Prepare archive", exact: true })
		.click();
	const contentButton = exporter.getByRole("button", {
		name: "Download content",
		exact: true,
	});
	await expect(contentButton).toBeVisible({ timeout: DERIVE_TIMEOUT });
	const contentEvent = page.waitForEvent("download");
	await contentButton.click();
	const contentDownload = await contentEvent;
	const filesEvent = page.waitForEvent("download");
	await exporter
		.getByRole("button", { name: "Download files", exact: true })
		.click();
	const filesDownload = await filesEvent;
	const contentBytes = await readDownload(contentDownload);
	const filesBytes = await readDownload(filesDownload);
	expect(contentBytes.toString("utf8")).toBe(exactExportedContent);
	const archiveId = /^ditero-content-([0-9a-f-]{36})\.json$/.exec(
		contentDownload.suggestedFilename(),
	)?.[1];
	expect(archiveId).toBeTruthy();
	expect(filesDownload.suggestedFilename()).toBe(
		`ditero-files-${archiveId}.json`,
	);
	const original: PortableExportV2 = JSON.parse(contentBytes.toString("utf8"));
	expect(original.schemaVersion).toBe(2);
	expect(original.data.attachments).toHaveLength(1);
	const source = original.data.attachments[0];
	const sourceTask = original.data.tasks.find(
		(row) => row.id === source?.parentId,
	);
	const sourceList = original.data.lists.find(
		(row) => row.id === sourceTask?.listId,
	);
	const workspace = original.data.workspaces.find(
		(row) => row.id === source?.workspaceId,
	);
	if (!source || !sourceTask || !sourceList || !workspace)
		throw new Error("Missing original attachment scope");
	await exporter
		.getByRole("button", { name: "Close", exact: true })
		.and(exporter.locator('[data-slot="button"]'))
		.click();
	await expect(exporter).toHaveCount(0);

	const panel = page.getByRole("region", { name: "Plan an import" });
	await panel.getByLabel("Native JSON export").setInputFiles({
		name: contentDownload.suggestedFilename(),
		mimeType: "application/json",
		buffer: contentBytes,
	});
	await panel.getByLabel("Source label").fill("Paired household archive");
	await expect(panel.getByTestId("import-workspace")).toHaveCount(
		original.data.workspaces.length,
	);
	for (const trigger of await panel.getByTestId("import-workspace").all())
		await chooseOption(page, trigger, workspace.name);
	const saved = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/api/portability/import/plans" &&
			response.ok(),
	);
	await panel
		.getByRole("button", { name: "Save dry run", exact: true })
		.click();
	const job = await (await saved).json();
	expect(job.report).toMatchObject({ plannerVersion: 5, applySupported: true });
	expect(job.documentDigest).toMatch(/^[0-9a-f]{64}$/);
	expect(job.mappingDigest).toMatch(/^[0-9a-f]{64}$/);
	await panel
		.getByRole("button", { name: "Apply import", exact: true })
		.click();
	await page.getByTestId("confirm-accept").click();
	await expect(panel.getByTestId("import-apply-status")).toContainText(
		"Import completed.",
		{ timeout: 20_000 },
	);
	const run = await page.request.get(
		`/api/portability/import/plans/${job.id}/run`,
	);
	expect(run.ok()).toBe(true);
	expect((await run.json()).run.state).toBe("completed");

	const parentsResponse = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname ===
				`/api/portability/import/plans/${job.id}/attachment-parents` &&
			response.ok(),
	);
	await panel
		.getByRole("button", { name: "Import selected files", exact: true })
		.click();
	const importer = page.getByTestId("attachment-archive-import-dialog");
	// The same loaded document remains available; reopening a saved job requires picking it again.
	await expect(importer.getByLabel("Exact paired content JSON")).toHaveCount(0);
	await importer.getByLabel("Encrypted files archive").setInputFiles({
		name: filesDownload.suggestedFilename(),
		mimeType: "application/json",
		buffer: filesBytes,
	});
	await importer
		.getByLabel("Archive passphrase", { exact: true })
		.fill(ARCHIVE_SECRET);
	await importer
		.getByRole("button", { name: "Open archive", exact: true })
		.click();
	const parents = await (await parentsResponse).json();
	const parent = parents.items.find(
		(item: { sourceAttachmentId: string }) =>
			item.sourceAttachmentId === source.id,
	);
	expect(parent).toMatchObject({
		blockedReason: null,
		destinationParent: { kind: "task", workspaceId: workspace.id },
	});
	expect(parent.destinationParent.id).not.toBe(sourceTask.id);
	const choice = importer.getByRole("radio", {
		name: `${FILE_NAME} Applied destination: ${taskTitle} Source file: ${source.id}`,
		exact: true,
	});
	await expect(choice).toBeVisible({ timeout: DERIVE_TIMEOUT });
	await expect(choice).toHaveCount(1);
	const migrationWrites: string[] = [];
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (
			request.method() !== "GET" &&
			(path ===
				`/api/portability/import/plans/${job.id}/attachment-reservations` ||
				/^\/api\/attachments\/migration_[^/]+\/upload$/.test(path) ||
				path === "/api/attachments/finalize")
		)
			migrationWrites.push(path);
	});
	await choice.check();
	await capture(page, "archive-retirement-selection-desktop-light");
	await importer
		.getByRole("button", { name: "Prepare file", exact: true })
		.click();
	const transfer = importer.getByRole("button", {
		name: "Transfer prepared file",
		exact: true,
	});
	await expect(transfer).toBeEnabled({ timeout: DERIVE_TIMEOUT });
	const statusURL = `/api/portability/import/plans/${job.id}/attachment-reservations?ordinal=${parent.ordinal}`;
	const absentBefore = await page.request.get(statusURL);
	expect(absentBefore.status()).toBe(404);
	expect(await absentBefore.json()).toMatchObject({
		code: "migration-not-found",
	});
	expect(migrationWrites).toEqual([]);
	await capture(page, "archive-retirement-prepared-desktop-light");
	const timeBefore = await page.evaluate(() => Date.now());
	await page.clock.fastForward(15 * 60_000 + 15_000 + 1);
	expect(await page.evaluate(() => Date.now())).toBeGreaterThanOrEqual(
		timeBefore + 915_001,
	);
	await expect(importer.getByRole("status")).toHaveText(
		m.archive_import_reopen(),
	);
	await expect(
		importer.getByText(m.archive_export_locked(), { exact: true }),
	).toBeVisible();
	await expect(importer.getByRole("radio")).toHaveCount(0);
	await expect(importer.getByText(FILE_NAME, { exact: true })).toHaveCount(0);
	await expect(
		importer.getByRole("button", { name: "Prepare file", exact: true }),
	).toHaveCount(0);
	await expect(transfer).toHaveCount(0);
	const absentAfter = await page.request.get(statusURL);
	expect(absentAfter.status()).toBe(404);
	expect(await absentAfter.json()).toMatchObject({
		code: "migration-not-found",
	});
	const aliveResponse = await page.request.get(
		"/api/portability/export?version=2",
	);
	expect(aliveResponse.ok()).toBe(true);
	const alive: PortableExportV2 = await aliveResponse.json();
	expect(alive.data.attachments.some((row) => row.id === source.id)).toBe(true);
	expect(
		alive.data.tasks.some((row) => row.id === parent.destinationParent.id),
	).toBe(true);
	expect(
		alive.data.attachments.filter(
			(row) => row.parentId === parent.destinationParent.id,
		),
	).toEqual([]);
	expect(migrationWrites).toEqual([]);
	await capture(page, "archive-retirement-locked-desktop-light");
	await importer
		.getByRole("button", { name: m.e2e_unlock_submit(), exact: true })
		.click();
	const unlock = page.getByTestId("e2e-unlock-dialog");
	await expect(unlock.getByTestId("e2e-unlock-description")).toHaveText(
		m.e2e_unlock_description_timeout(),
	);
	await unlock.getByTestId("e2e-unlock-passphrase").fill(ACCOUNT_SECRET);
	await unlock.getByTestId("e2e-unlock-submit").click();
	await expect(unlock).toHaveCount(0, { timeout: DERIVE_TIMEOUT });
	await expect(
		importer.getByText(m.archive_export_locked(), { exact: true }),
	).toHaveCount(0);
	await expect(importer.getByRole("status")).toHaveText(
		m.archive_import_reopen(),
	);
	await expect(importer.getByRole("radio")).toHaveCount(0);
	await expect(importer.getByText(FILE_NAME, { exact: true })).toHaveCount(0);
	await expect(
		importer.getByRole("button", { name: "Open archive", exact: true }),
	).toHaveCount(0);
	await expect(
		importer.getByRole("button", { name: "Prepare file", exact: true }),
	).toHaveCount(0);
	await expect(transfer).toHaveCount(0);
	expect(migrationWrites).toEqual([]);
	await capture(page, "archive-retirement-unlocked-retired-desktop-light");
	await importer
		.getByRole("button", { name: "Close", exact: true })
		.and(importer.locator('[data-slot="button"]'))
		.click();
	await expect(importer).toHaveCount(0);
	await panel
		.getByRole("button", { name: "Import selected files", exact: true })
		.click();
	const reopened = page.getByTestId("attachment-archive-import-dialog");
	await expect(
		reopened.getByRole("button", { name: "Open archive", exact: true }),
	).toBeDisabled();
	await expect(
		reopened.getByLabel("Archive passphrase", { exact: true }),
	).toHaveValue("");
	await expect(reopened.getByRole("radio")).toHaveCount(0);
	await reopened.getByLabel("Encrypted files archive").setInputFiles({
		name: filesDownload.suggestedFilename(),
		mimeType: "application/json",
		buffer: filesBytes,
	});
	await reopened
		.getByLabel("Archive passphrase", { exact: true })
		.fill(ARCHIVE_SECRET);
	await reopened
		.getByRole("button", { name: "Open archive", exact: true })
		.click();
	const renewedChoice = reopened.getByRole("radio", {
		name: `${FILE_NAME} Applied destination: ${taskTitle} Source file: ${source.id}`,
		exact: true,
	});
	await expect(renewedChoice).toBeVisible({ timeout: DERIVE_TIMEOUT });
	await expect(renewedChoice).toBeEnabled();
	expect(migrationWrites).toEqual([]);
	const absentReopened = await page.request.get(statusURL);
	expect(absentReopened.status()).toBe(404);
	expect(await absentReopened.json()).toMatchObject({
		code: "migration-not-found",
	});
});
