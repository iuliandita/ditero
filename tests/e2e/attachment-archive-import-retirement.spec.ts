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
async function captureResponseBody(page: Page, path: string, method: string) {
	const url = new URL(path, page.url()).href;
	let finish!: (result: { body: string } | { error: unknown }) => void;
	const captured = new Promise<{ body: string } | { error: unknown }>(
		(resolve) => {
			finish = resolve;
		},
	);
	await page.route(
		url,
		async (route) => {
			try {
				expect(route.request().method()).toBe(method);
				const actual = await route.fetch({ timeout: 15_000, maxRetries: 0 });
				expect(actual.status()).toBe(200);
				const body = await actual.text();
				await route.fulfill({ response: actual });
				finish({ body });
			} catch (error) {
				await route.abort().catch(() => {});
				finish({ error });
			}
		},
		{ times: 1 },
	);
	const observed = page
		.waitForResponse(
			(response) =>
				response.url() === url && response.request().method() === method,
		)
		.then(
			(actual) => ({ actual }),
			(error: unknown) => ({ error }),
		);
	return async () => {
		const capture = await captured;
		if ("error" in capture) throw capture.error;
		const browser = await observed;
		if ("error" in browser) throw browser.error;
		expect(browser.actual.ok()).toBe(true);
		return capture.body;
	};
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

async function captureRecoveryVariants(page: Page, name: string) {
	await page.mouse.move(8, 8);
	await capture(page, name);
	await page.emulateMedia({ colorScheme: "dark" });
	await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
	await capture(page, `${name}-desktop-dark`);
	await page.setViewportSize({ width: 390, height: 844 });
	const dialog = page.getByTestId("attachment-archive-import-dialog");
	await expect(async () => {
		const bounds = await dialog.boundingBox();
		expect(bounds).not.toBeNull();
		if (!bounds) throw new Error("Recovery dialog has no measured bounds");
		expect(bounds.x).toBeGreaterThanOrEqual(8);
		expect(bounds.width).toBeLessThanOrEqual(374);
		expect(bounds.height).toBeLessThanOrEqual(812);
		expect(
			await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
		).toBe(true);
	}).toPass({ timeout: 5000 });
	await capture(page, `${name}-phone-dark`);
	await page.emulateMedia({ colorScheme: "light" });
	await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
	await capture(page, `${name}-phone-light`);
	await page.setViewportSize({ width: 1440, height: 1000 });
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
	await page.emulateMedia({ colorScheme: "light" });
	await page.getByTestId("theme-switcher").click();
	await page.getByRole("option", { name: "Match system", exact: true }).click();
	await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
	const contentResponse = await captureResponseBody(
		page,
		"/api/portability/export?version=2",
		"GET",
	);
	await page
		.getByRole("button", { name: "Export selected files", exact: true })
		.click();
	const exporter = page.getByTestId("attachment-archive-export-dialog");
	await exporter
		.getByRole("checkbox", { name: FILE_NAME, exact: true })
		.check({ timeout: DERIVE_TIMEOUT });
	const exactExportedContent = await contentResponse();
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
	const sourcesURL = new URL("/api/portability/import/sources", page.url())
		.href;
	let releaseSources!: () => void;
	const heldSources = new Promise<void>((resolve) => {
		releaseSources = resolve;
	});
	let observeSources!: () => void;
	const sourcesReached = new Promise<void>((resolve) => {
		observeSources = resolve;
	});
	let finishSources!: (result: { ok: true } | { error: unknown }) => void;
	const sourcesDelivered = new Promise<{ ok: true } | { error: unknown }>(
		(resolve) => {
			finishSources = resolve;
		},
	);
	let sourcesFulfilled = false;
	await page.route(
		sourcesURL,
		async (route) => {
			try {
				expect(route.request().method()).toBe("GET");
				observeSources();
				const actual = await route.fetch({ timeout: 15_000, maxRetries: 0 });
				expect(actual.status()).toBe(200);
				await heldSources;
				await route.fulfill({ response: actual });
				sourcesFulfilled = true;
				finishSources({ ok: true });
			} catch (error) {
				await route.abort().catch(() => {});
				finishSources({ error });
			}
		},
		{ times: 1 },
	);
	const saved = await captureResponseBody(
		page,
		"/api/portability/import/plans",
		"POST",
	);
	await panel
		.getByRole("button", { name: "Save dry run", exact: true })
		.click();
	const job = JSON.parse(await saved());
	expect(job.report).toMatchObject({ plannerVersion: 5, applySupported: true });
	expect(job.documentDigest).toMatch(/^[0-9a-f]{64}$/);
	expect(job.mappingDigest).toMatch(/^[0-9a-f]{64}$/);
	try {
		await sourcesReached;
		await expect(
			panel.getByRole("heading", { name: "Saved import plan", exact: true }),
		).toBeVisible();
		await expect(
			panel.getByRole("button", { name: "Apply import", exact: true }),
		).toBeEnabled();
		await expect(
			panel.getByRole("button", { name: "Save dry run", exact: true }),
		).toBeEnabled();
		expect(sourcesFulfilled).toBe(false);
		await capture(page, "import-plan-ready-with-stalled-sources");
	} finally {
		releaseSources();
	}
	const deliveredSources = await sourcesDelivered;
	if ("error" in deliveredSources) throw deliveredSources.error;
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

	const parentsResponse = await captureResponseBody(
		page,
		`/api/portability/import/plans/${job.id}/attachment-parents?afterOrdinal=-1&limit=64`,
		"GET",
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
	const parents = JSON.parse(await parentsResponse());
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
	await renewedChoice.check();
	await reopened
		.getByRole("button", { name: m.archive_import_prepare(), exact: true })
		.click();
	await expect(
		reopened.getByRole("button", {
			name: m.archive_import_transfer(),
			exact: true,
		}),
	).toBeEnabled({ timeout: DERIVE_TIMEOUT });
	let interruptedTarget = "";
	await page.route(
		"**/api/attachments/migration_*/upload",
		async (route) => {
			interruptedTarget =
				new URL(route.request().url()).pathname.split("/")[3] ?? "";
			await route.abort();
		},
		{ times: 1 },
	);
	await reopened
		.getByRole("button", { name: m.archive_import_transfer(), exact: true })
		.click();
	await expect(reopened.getByRole("status")).toHaveText(
		m.archive_import_uncertain(),
	);
	expect(interruptedTarget).toMatch(/^migration_/);
	const retainedBefore = await page.request.get(
		`/api/portability/import/plans/${job.id}/attachment-migrations?ordinal=${parent.ordinal}`,
	);
	expect(retainedBefore.ok()).toBe(true);
	const previous = await retainedBefore.json();
	expect(previous).toMatchObject({
		targetAttachmentId: interruptedTarget,
		revision: 1,
		committed: false,
		attachmentState: "reserved",
		recoverable: false,
	});
	await reopened
		.getByRole("button", { name: "Close", exact: true })
		.and(reopened.locator('[data-slot="button"]'))
		.click();
	await expect(reopened).toHaveCount(0);
	await panel
		.getByRole("button", { name: "Import selected files", exact: true })
		.click();
	const recovered = page.getByTestId("attachment-archive-import-dialog");
	await recovered.getByLabel("Encrypted files archive").setInputFiles({
		name: filesDownload.suggestedFilename(),
		mimeType: "application/json",
		buffer: filesBytes,
	});
	await recovered
		.getByLabel("Archive passphrase", { exact: true })
		.fill(ARCHIVE_SECRET);
	await recovered
		.getByRole("button", { name: "Open archive", exact: true })
		.click();
	await recovered
		.getByRole("radio", {
			name: `${FILE_NAME} Applied destination: ${taskTitle} Source file: ${source.id}`,
			exact: true,
		})
		.check({ timeout: DERIVE_TIMEOUT });
	await expect(recovered.getByRole("status")).toHaveText(
		"Status checked: the previous transfer is unfinished.",
	);
	await expect(
		recovered.getByRole("group", {
			name: "Choose one file and its applied destination",
			exact: true,
		}),
	).toBeVisible();
	const recoveryWrites: string[] = [];
	const repeatedContentApplies: string[] = [];
	page.on("request", (request) => {
		if (request.method() !== "POST") return;
		const path = new URL(request.url()).pathname;
		if (path.endsWith("/attachment-recoveries"))
			recoveryWrites.push(request.postData() ?? "");
		if (path.endsWith("/apply")) repeatedContentApplies.push(path);
	});
	await recovered
		.getByRole("button", { name: m.archive_import_replace(), exact: true })
		.click();
	await expect(
		recovered.getByText(m.archive_import_replace_confirmation(), {
			exact: true,
		}),
	).toBeVisible();
	expect(recoveryWrites).toEqual([]);
	const confirmation = recovered.getByRole("button", {
		name: "Confirm replacement",
		exact: true,
	});
	await expect(confirmation).toBeFocused();
	await expect(confirmation).toHaveAccessibleDescription(
		"This abandons the current file transfer, including any upload still in progress. A fresh encrypted transfer will use the same applied destination. Continue?",
	);
	await expect(
		recovered.getByRole("button", { name: "Cancel", exact: true }),
	).toBeEnabled();
	await expect(
		recovered.getByText(
			"This attempt needs explicit recovery. Open the original archive and check its retained transfer before choosing a replacement.",
			{ exact: true },
		),
	).toHaveCount(0);
	await captureRecoveryVariants(
		page,
		"archive-reopened-live-replacement-confirmation",
	);
	await recovered
		.getByRole("button", {
			name: m.archive_import_replace_confirm(),
			exact: true,
		})
		.click();
	await expect(recovered.getByRole("status")).toHaveText(
		m.archive_import_complete(),
		{ timeout: DERIVE_TIMEOUT },
	);
	expect(recoveryWrites).toHaveLength(1);
	const recoveryRequest = JSON.parse(recoveryWrites[0] ?? "");
	expect(recoveryRequest).toMatchObject({
		retireLive: true,
		previous: {
			associationId: previous.associationId,
			attemptId: previous.attemptId,
			targetAttachmentId: interruptedTarget,
			revision: 1,
		},
	});
	expect(recoveryRequest.prepared.id).not.toBe(interruptedTarget);
	expect(repeatedContentApplies).toEqual([]);
	const retainedAfter = await page.request.get(
		`/api/portability/import/plans/${job.id}/attachment-migrations?ordinal=${parent.ordinal}`,
	);
	expect(retainedAfter.ok()).toBe(true);
	const completed = await retainedAfter.json();
	expect(completed).toMatchObject({
		associationId: previous.associationId,
		revision: 2,
		targetAttachmentId: recoveryRequest.prepared.id,
		committed: true,
		destinationParent: parent.destinationParent,
	});
	const afterRecoveryExport = await page.request.get(
		"/api/portability/export?version=2",
	);
	expect(afterRecoveryExport.ok()).toBe(true);
	const afterRecovery: PortableExportV2 = await afterRecoveryExport.json();
	expect(
		afterRecovery.data.attachments.filter(
			(row) => row.parentId === parent.destinationParent.id,
		),
	).toHaveLength(1);
	expect(
		afterRecovery.data.tasks.filter(
			(row) => row.id === parent.destinationParent.id,
		),
	).toHaveLength(1);
	await expect(recovered.getByRole("radio").first()).toBeChecked();
	await expect(
		recovered.getByText(
			"Stopping or closing only cancels local work. A server operation may already have completed. Check its status before retrying; no replacement is created automatically.",
			{ exact: true },
		),
	).toHaveCount(0);
	await captureRecoveryVariants(page, "archive-reopened-replacement-completed");
	await recovered
		.getByRole("button", { name: "Close", exact: true })
		.and(recovered.locator('[data-slot="button"]'))
		.click();
	await expect(recovered).toHaveCount(0);
	await panel
		.getByRole("button", { name: "Import selected files", exact: true })
		.click();
	const completedReopened = page.getByTestId(
		"attachment-archive-import-dialog",
	);
	await completedReopened.getByLabel("Encrypted files archive").setInputFiles({
		name: filesDownload.suggestedFilename(),
		mimeType: "application/json",
		buffer: filesBytes,
	});
	await completedReopened
		.getByLabel("Archive passphrase", { exact: true })
		.fill(ARCHIVE_SECRET);
	await completedReopened
		.getByRole("button", { name: "Open archive", exact: true })
		.click();
	await completedReopened
		.getByRole("radio", {
			name: `${FILE_NAME} Applied destination: ${taskTitle} Source file: ${source.id}`,
			exact: true,
		})
		.check({ timeout: DERIVE_TIMEOUT });
	await expect(completedReopened.getByRole("status")).toHaveText(
		m.archive_import_complete(),
	);
	await expect(
		completedReopened.getByRole("button", {
			name: m.archive_import_replace(),
			exact: true,
		}),
	).toHaveCount(0);
	expect(recoveryWrites).toHaveLength(1);
	expect(repeatedContentApplies).toEqual([]);
});
