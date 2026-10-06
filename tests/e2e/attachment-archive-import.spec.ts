import AxeBuilder from "@axe-core/playwright";
import {
	type Download,
	expect,
	type Page,
	type Route,
	test,
} from "@playwright/test";
import type { PortableExportV2 } from "../../src/domain/portability/v2.ts";
import { m } from "../../src/paraglide/messages.js";
import {
	chooseOption,
	goToSettings,
	leaveSettings,
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

test("archive import: exact exported v2 pair commits to its applied parent after a lost finalize response", async ({
	page,
}) => {
	test.setTimeout(120_000);
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
	const exportURL = new URL("/api/portability/export?version=2", page.url())
		.href;
	let finishCapture!: (result: { body: string } | { error: unknown }) => void;
	const captured = new Promise<{ body: string } | { error: unknown }>(
		(resolve) => {
			finishCapture = resolve;
		},
	);
	await page.route(
		exportURL,
		async (route: Route) => {
			try {
				expect(route.request().method()).toBe("GET");
				const actual = await route.fetch({ timeout: 15_000, maxRetries: 0 });
				expect(actual.status()).toBe(200);
				const body = await actual.text();
				await route.fulfill({ response: actual });
				finishCapture({ body });
			} catch (error) {
				await route.abort().catch(() => {});
				finishCapture({ error });
			}
		},
		{ times: 1 },
	);
	const contentResponse = page.waitForResponse(exportURL).then(
		(actual) => ({ actual }),
		(error: unknown) => ({ error }),
	);
	await page
		.getByRole("button", { name: "Export selected files", exact: true })
		.click();
	const exportCaptureResult = await captured;
	if ("error" in exportCaptureResult) throw exportCaptureResult.error;
	const exporter = page.getByTestId("attachment-archive-export-dialog");
	await exporter
		.getByRole("checkbox", { name: FILE_NAME, exact: true })
		.check({ timeout: DERIVE_TIMEOUT });
	const exportBrowserResult = await contentResponse;
	if ("error" in exportBrowserResult) throw exportBrowserResult.error;
	expect(exportBrowserResult.actual.ok()).toBe(true);
	const exactExportedContent = exportCaptureResult.body;
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

	const parentsURL = new URL(
		`/api/portability/import/plans/${job.id}/attachment-parents`,
		page.url(),
	).href;
	let finishParentCapture!: (
		result: { body: string } | { error: unknown },
	) => void;
	const capturedParents = new Promise<{ body: string } | { error: unknown }>(
		(resolve) => {
			finishParentCapture = resolve;
		},
	);
	await page.route(
		parentsURL,
		async (route: Route) => {
			try {
				expect(route.request().method()).toBe("GET");
				const actual = await route.fetch({ timeout: 15_000, maxRetries: 0 });
				expect(actual.status()).toBe(200);
				const body = await actual.text();
				await route.fulfill({ response: actual });
				finishParentCapture({ body });
			} catch (error) {
				await route.abort().catch(() => {});
				finishParentCapture({ error });
			}
		},
		{ times: 1 },
	);
	const parentsResponse = page.waitForResponse(parentsURL).then(
		(actual) => ({ actual }),
		(error: unknown) => ({ error }),
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
	const parentCaptureResult = await capturedParents;
	if ("error" in parentCaptureResult) throw parentCaptureResult.error;
	const parentBrowserResult = await parentsResponse;
	if ("error" in parentBrowserResult) throw parentBrowserResult.error;
	expect(parentBrowserResult.actual.ok()).toBe(true);
	const parents = JSON.parse(parentCaptureResult.body);
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
	await choice.check();
	await expect(choice).toBeChecked();
	await capture(page, "archive-import-selection-desktop-light");
	await importer
		.getByRole("button", { name: "Prepare file", exact: true })
		.click();
	const transfer = importer.getByRole("button", {
		name: "Transfer prepared file",
		exact: true,
	});
	await expect(transfer).toBeEnabled({ timeout: DERIVE_TIMEOUT });
	await expect(choice).toBeChecked();
	await expect(choice).toBeDisabled();
	await expect(
		importer.getByText(m.archive_import_choose(), { exact: true }),
	).toHaveCount(0);
	let committedId = "";
	let finalizeCalls = 0;
	let reserveCalls = 0;
	let uploadCalls = 0;
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (
			request.method() === "POST" &&
			path === `/api/portability/import/plans/${job.id}/attachment-reservations`
		)
			reserveCalls++;
		if (
			request.method() !== "GET" &&
			/^\/api\/attachments\/migration_[^/]+\/upload$/.test(path)
		)
			uploadCalls++;
		if (
			request.method() === "POST" &&
			new URL(request.url()).pathname === "/api/attachments/finalize"
		)
			finalizeCalls++;
	});
	await page.route(
		"**/api/attachments/finalize",
		async (route) => {
			const actual = await route.fetch();
			expect(actual.status()).toBe(200);
			const receipt = await actual.json();
			expect(receipt.state).toBe("committed");
			expect(receipt.id).toMatch(/^migration_/);
			committedId = receipt.id;
			await route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({ code: "unavailable" }),
			});
		},
		{ times: 1 },
	);
	const reservationURL = new URL(
		`/api/portability/import/plans/${job.id}/attachment-reservations`,
		page.url(),
	).href;
	let finishReservation!: (
		result: { body: unknown } | { error: unknown },
	) => void;
	const capturedReservation = new Promise<
		{ body: unknown } | { error: unknown }
	>((resolve) => {
		finishReservation = resolve;
	});
	await page.route(
		reservationURL,
		async (route: Route) => {
			try {
				expect(route.request().method()).toBe("POST");
				const actual = await route.fetch({ timeout: 15_000, maxRetries: 0 });
				expect(actual.status()).toBe(200);
				const body: unknown = await actual.json();
				await route.fulfill({ response: actual });
				finishReservation({ body });
			} catch (error) {
				await route.abort().catch(() => {});
				finishReservation({ error });
			}
		},
		{ times: 1 },
	);
	const reserved = page
		.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				response.url() === reservationURL,
		)
		.then(
			(actual) => ({ actual }),
			(error: unknown) => ({ error }),
		);
	const transferred = page.waitForResponse(
		(response) =>
			/\/api\/attachments\/migration_[^/]+\/upload$/.test(
				new URL(response.url()).pathname,
			) && response.ok(),
	);
	await transfer.click();
	const captureResult = await capturedReservation;
	if ("error" in captureResult) throw captureResult.error;
	const browserResult = await reserved;
	if ("error" in browserResult) throw browserResult.error;
	expect(browserResult.actual.ok()).toBe(true);
	const reservation = captureResult.body;
	expect(typeof reservation).toBe("object");
	if (
		!reservation ||
		typeof reservation !== "object" ||
		!("targetAttachmentId" in reservation)
	) {
		throw new Error("Missing actual reservation attachment identity");
	}
	expect(reservation).toMatchObject({ revision: 1, committed: false });
	expect(reservation.targetAttachmentId).toMatch(/^migration_/);
	expect((await transferred).ok()).toBe(true);
	await expect(importer.getByRole("status")).toContainText(
		"The server outcome is uncertain.",
	);
	expect(committedId).toBe(reservation.targetAttachmentId);
	expect(finalizeCalls).toBe(1);
	await expect(choice).toBeChecked();
	await expect(choice).toBeDisabled();
	await expect(
		importer.getByText(m.archive_import_choose(), { exact: true }),
	).toHaveCount(0);
	const reconcile = importer.getByRole("button", {
		name: "Check server status",
		exact: true,
	});
	const retry = importer.getByRole("button", {
		name: "Retry this attempt",
		exact: true,
	});
	await expect(reconcile).toHaveAttribute("data-variant", "default");
	await expect(reconcile).toHaveClass(/(?:^|\s)bg-primary(?:\s|$)/);
	await expect(retry).toHaveAttribute("data-variant", "outline");
	await expect(retry).not.toHaveClass(/(?:^|\s)bg-primary(?:\s|$)/);
	await capture(page, "archive-import-uncertain-desktop-light");
	let releaseStatus!: () => void;
	const heldStatus = new Promise<void>((resolve) => {
		releaseStatus = resolve;
	});
	let statusReached!: () => void;
	let statusFailed!: (error: unknown) => void;
	const observedStatus = new Promise<void>((resolve, reject) => {
		statusReached = resolve;
		statusFailed = reject;
	});
	let deliveryReached!: () => void;
	let deliveryFailed!: (error: unknown) => void;
	const deliveredStatus = new Promise<void>((resolve, reject) => {
		deliveryReached = resolve;
		deliveryFailed = reject;
	});
	// Observe rejection immediately; every started handler is also awaited below.
	void deliveredStatus.catch(() => undefined);
	const waitForDelivery = async () => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				deliveredStatus,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("Held status delivery did not finish")),
						5_000,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	};
	let statusCalls = 0;
	let statusWitness: unknown;
	const statusPattern = `**/api/portability/import/plans/${job.id}/attachment-reservations**`;
	const holdStatus = async (route: Route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (
			request.method() !== "GET" ||
			url.searchParams.get("ordinal") !== String(parent.ordinal)
		) {
			await route.continue();
			return;
		}
		try {
			statusCalls++;
			const actual = await route.fetch();
			expect(actual.status()).toBe(200);
			const confirmed = await actual.json();
			expect(confirmed).toMatchObject({
				targetAttachmentId: committedId,
				committed: true,
			});
			expect(confirmed.committedAt).toBeTruthy();
			statusWitness = confirmed;
			statusReached();
			await heldStatus;
			await route.fulfill({ response: actual });
			deliveryReached();
		} catch (error) {
			statusFailed(error);
			deliveryFailed(error);
		}
	};
	await page.route(statusPattern, holdStatus);
	let statusProbeFailed = false;
	let cleanupFailure: unknown;
	try {
		await reconcile.scrollIntoViewIfNeeded();
		await expect(reconcile).toBeEnabled();
		const beforeBox = await reconcile.boundingBox();
		if (!beforeBox)
			throw new Error("Recovery button positive geometry missing");
		const point = {
			x: beforeBox.x + beforeBox.width / 2,
			y: beforeBox.y + beforeBox.height / 2,
		};
		await page.mouse.click(point.x, point.y);
		await observedStatus;
		await expect(reconcile).toBeDisabled();
		await expect(retry).toBeDisabled();
		await expect(importer.getByRole("status")).toContainText(
			"The server outcome is uncertain.",
		);
		const disabledPoint = await reconcile.evaluate((button) => {
			const box = button.getBoundingClientRect();
			const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
			const hit = document.elementFromPoint(point.x, point.y);
			return {
				...point,
				visible: box.width > 0 && box.height > 0,
				pointerEvents: getComputedStyle(button).pointerEvents,
				unobscured: Boolean(
					hit &&
						(hit === button || button.contains(hit) || hit.contains(button)),
				),
			};
		});
		expect(disabledPoint.visible).toBe(true);
		expect(disabledPoint.pointerEvents).toBe("none");
		expect(disabledPoint.unobscured).toBe(true);
		expect({ statusCalls, reserveCalls, uploadCalls, finalizeCalls }).toEqual({
			statusCalls: 1,
			reserveCalls: 1,
			uploadCalls: 1,
			finalizeCalls: 1,
		});
		await page.mouse.click(disabledPoint.x, disabledPoint.y);
		await expect(reconcile).toBeDisabled();
		await expect(retry).toBeDisabled();
		expect({ statusCalls, reserveCalls, uploadCalls, finalizeCalls }).toEqual({
			statusCalls: 1,
			reserveCalls: 1,
			uploadCalls: 1,
			finalizeCalls: 1,
		});
		releaseStatus();
		await waitForDelivery();
		expect(statusWitness).toMatchObject({
			targetAttachmentId: committedId,
			committed: true,
		});
		expect(statusWitness).toHaveProperty("committedAt", expect.anything());
		await expect(importer.getByRole("status")).toHaveText(
			"File committed and confirmed by the server.",
		);
		expect({ statusCalls, reserveCalls, uploadCalls, finalizeCalls }).toEqual({
			statusCalls: 1,
			reserveCalls: 1,
			uploadCalls: 1,
			finalizeCalls: 1,
		});
	} catch (error) {
		statusProbeFailed = true;
		throw error;
	} finally {
		releaseStatus();
		if (statusCalls > 0) {
			try {
				await waitForDelivery();
			} catch (error) {
				cleanupFailure = error;
				test.info().annotations.push({
					type: "secondary-delivery-error",
					description:
						error instanceof Error ? error.name : "Unknown delivery error",
				});
			}
		}
		try {
			await page.unroute(statusPattern, holdStatus);
		} catch (error) {
			cleanupFailure ??= error;
			test.info().annotations.push({
				type: "secondary-cleanup-error",
				description:
					error instanceof Error ? error.name : "Unknown cleanup error",
			});
		}
	}
	if (!statusProbeFailed && cleanupFailure) throw cleanupFailure;
	await expect(importer.getByRole("status")).toHaveText(
		"File committed and confirmed by the server.",
	);
	expect(finalizeCalls).toBe(1);
	const { violations } = await new AxeBuilder({ page })
		.include('[data-testid="attachment-archive-import-dialog"]')
		.analyze();
	expect(
		violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
	).toEqual([]);
	await expect(choice).toBeChecked();
	await expect(choice).toBeDisabled();
	await expect(
		importer.getByText(m.archive_import_choose(), { exact: true }),
	).toHaveCount(0);
	await capture(page, "archive-import-completed-desktop-light");
	await importer
		.getByRole("button", { name: "Close", exact: true })
		.and(importer.locator('[data-slot="button"]'))
		.click();
	await expect(importer).toHaveCount(0);
	await expect(
		panel.getByRole("button", { name: "Import selected files", exact: true }),
	).toBeFocused();
	await leaveSettings(page);
	const readback = await page.request.get("/api/portability/export?version=2");
	expect(readback.ok()).toBe(true);
	const destination: PortableExportV2 = await readback.json();
	const row = destination.data.attachments.find(
		(item) => item.id === committedId,
	);
	expect(row).toMatchObject({
		parentKind: "task",
		parentId: parent.destinationParent.id,
		workspaceId: workspace.id,
	});
	expect(row?.committedAt).toBeTruthy();
	const targetTask = destination.data.tasks.find(
		(item) => item.id === parent.destinationParent.id,
	);
	if (!targetTask) throw new Error("Missing mapped destination task");
	await page
		.locator(`nav[aria-label="Lists"] [data-list-id="${targetTask.listId}"]`)
		.click();
	await page.locator(`[data-task-id="${targetTask.id}"]`).click();
	await openMoreOptions(
		page.getByRole("dialog", { name: m.task_detail_title() }),
	);
	const tile = page
		.getByTestId("task-attachments")
		.getByRole("listitem")
		.filter({ hasText: FILE_NAME });
	await expect(tile).toBeVisible({ timeout: 20_000 });
	await tile.getByTestId("row-actions").click();
	const downloadEvent = page.waitForEvent("download");
	await page.getByTestId("row-action-download").click();
	const download = await downloadEvent;
	expect(download.suggestedFilename()).toBe(FILE_NAME);
	expect(await readDownload(download)).toEqual(Buffer.from(PLAINTEXT));
});
