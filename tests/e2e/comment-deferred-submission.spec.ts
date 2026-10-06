import { expect, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import type { PortableExportV2 } from "../../src/domain/portability/v2.ts";
import { m } from "../../src/paraglide/messages.js";
import { installCommentFocusDiagnostics } from "./comment-focus-diagnostics.ts";
import {
	openDetails,
	openMoreOptions,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

const ACCOUNT_SECRET = "correct horse battery staple";
const deriveTimeout = 30_000;
const COMMENT_TEXT = "Keep this file with the comment";
const FILE_NAME = "comment-selection-note.txt";
async function enroll(page: Page) {
	await expect(page.getByTestId("e2e-enroll-dialog")).toBeVisible();
	await page.getByTestId("e2e-passphrase").fill(ACCOUNT_SECRET);
	await page.getByTestId("e2e-passphrase-confirm").fill(ACCOUNT_SECRET);
	await page.getByTestId("e2e-enroll-continue").click();
	const recovery = page.getByTestId("e2e-recovery-code");
	await expect(recovery).toBeVisible({ timeout: deriveTimeout });
	await page
		.getByTestId("e2e-recovery-confirm")
		.fill((await recovery.innerText()).replace(/\s+/g, "-"));
	await page.getByTestId("e2e-recovery-submit").click();
	await page.getByTestId("e2e-enroll-close").click({ timeout: deriveTimeout });
	await expect(page.getByTestId("e2e-enroll-dialog")).toHaveCount(0, {
		timeout: deriveTimeout,
	});
}

async function capture(page: Page, name: string) {
	const path = test.info().outputPath(`${name}.png`);
	await page.screenshot({ path, fullPage: false });
	await test.info().attach(name, { path, contentType: "image/png" });
}

async function exported(page: Page): Promise<PortableExportV2> {
	const response = await page.request.get("/api/portability/export?version=2");
	expect(response.ok()).toBe(true);
	return await response.json();
}

async function seed(page: Page) {
	await signUp(page, uniqueEmail("comment-config-refusal"));
	await waitWorkspaceReady(page);
	const listName = `Comment selection ${Date.now()}`;
	const taskName = "Keep the comment file together";
	await page.getByTestId("create-list-open").click();
	await page.getByTestId("new-list").fill(listName);
	await page.getByTestId("new-list-submit").click();
	await page
		.locator('nav[aria-label="Lists"]')
		.getByRole("button", { name: listName, exact: true })
		.first()
		.click();
	await page.getByTestId("new-task").fill(taskName);
	await page.getByTestId("new-task-submit").click();
	await openDetails(page, taskName);
	const detail = page.getByRole("dialog", { name: m.task_detail_title() });
	await openMoreOptions(detail);
	const initialCommit = page.waitForResponse("**/api/attachments/finalize");
	await page
		.getByTestId("task-attachments")
		.locator("xpath=ancestor::fieldset")
		.getByTestId("attachment-input")
		.setInputFiles({
			name: "key-ready.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("key readiness control"),
		});
	await enroll(page);
	expect((await initialCommit).ok()).toBe(true);
	await expect(
		page.getByTestId("task-attachments").getByRole("button", {
			name: m.attachment_open_named({ name: "key-ready.txt" }),
			exact: true,
		}),
	).toBeVisible({ timeout: 20_000 });
	const before = await exported(page);
	const task = before.data.tasks.find((row) => row.title === taskName);
	expect(task).toBeDefined();
	if (!task) throw new Error("Owned task positive control missing");
	expect(before.data.comments.filter((row) => row.taskId === task.id)).toEqual(
		[],
	);
	const composer = page.getByTestId("comment-input");
	await composer.fill(COMMENT_TEXT);
	const send = page.getByTestId("comment-submit");
	await expect(send).toBeEnabled();
	await composer
		.locator("xpath=ancestor::fieldset")
		.getByTestId("attachment-input")
		.setInputFiles({
			name: FILE_NAME,
			mimeType: "text/plain",
			buffer: Buffer.from("real encrypted comment file"),
		});
	const pendingFile = page
		.getByTestId("comment-pending-files")
		.getByRole("listitem")
		.filter({ hasText: FILE_NAME });
	await expect(pendingFile).toHaveCount(1);
	await expect(
		pendingFile.getByText(m.attachment_ready_to_upload(), { exact: true }),
	).toBeVisible();
	await expect(send).toBeEnabled();
	await expect(
		pendingFile.getByRole("button", {
			name: m.attachment_cancel_upload(),
			exact: true,
		}),
	).toBeVisible();
	return { task, composer, send, pendingFile };
}

test("comment config refusal restores focus and preserves selection before one real retry", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const { task, composer, send, pendingFile } = await seed(page);
	let refusals = 0;
	const refuseConfig = async (route: import("@playwright/test").Route) => {
		refusals += 1;
		await route.fulfill({
			status: 503,
			contentType: "application/json",
			body: JSON.stringify({ error: "unavailable" }),
		});
	};
	await page.route("**/api/attachments/config", refuseConfig);
	let cleanupFailure: unknown;
	try {
		const refused = page.waitForResponse("**/api/attachments/config");
		await send.click();
		expect((await refused).status()).toBe(503);
		await expect(
			page
				.getByTestId("comment-thread")
				.getByText(m.attachment_error_reserve_failed(), { exact: true }),
		).toBeVisible();
		await expect(composer).toBeEnabled();
		await expect(composer).toBeFocused();
		await expect(composer).toHaveValue(COMMENT_TEXT);
		await expect(pendingFile).toBeVisible();
		await expect(
			pendingFile.getByRole("button", {
				name: m.attachment_cancel_upload(),
				exact: true,
			}),
		).toBeVisible();
		expect(refusals).toBe(1);
		const before = await exported(page);
		expect(before.data.tasks.some((row) => row.id === task.id)).toBe(true);
		expect(
			before.data.comments.filter((row) => row.taskId === task.id),
		).toEqual([]);
		expect(
			before.data.attachments.filter((row) => row.parentKind === "comment"),
		).toEqual([]);
		await capture(page, "comment-config-refused-focus-desktop-light");
	} finally {
		try {
			await page.unroute("**/api/attachments/config", refuseConfig);
		} catch (error) {
			cleanupFailure = error;
			test.info().annotations.push({
				type: "secondary-route-cleanup",
				description:
					error instanceof Error ? error.name : "Unknown cleanup error",
			});
		}
	}
	if (cleanupFailure) throw cleanupFailure;
	await page.evaluate(installCommentFocusDiagnostics);
	let retryFailed = false;
	let retryError: unknown;
	let retryCleanupFailed = false;
	let retryCleanupError: unknown;
	try {
		const committed = page.waitForResponse("**/api/attachments/finalize");
		await send.click();
		expect((await committed).ok()).toBe(true);
		await expect
			.poll(async () => {
				const after = await exported(page);
				expect(after.data.tasks.some((row) => row.id === task.id)).toBe(true);
				const comments = after.data.comments.filter(
					(row) => row.taskId === task.id,
				);
				return {
					comments: comments.length,
					body: comments[0]?.body,
					files: after.data.attachments.filter(
						(row) =>
							row.parentKind === "comment" &&
							comments.some((comment) => comment.id === row.parentId),
					).length,
				};
			})
			.toEqual({ comments: 1, body: COMMENT_TEXT, files: 1 });
		await expect(
			page.getByTestId("comment-item").getByRole("button", {
				name: m.attachment_open_named({ name: FILE_NAME }),
				exact: true,
			}),
		).toBeVisible({ timeout: 20_000 });
		await expect(composer).toHaveValue("");
		await expect(composer).toBeFocused();
		await capture(page, "comment-config-retry-completed-desktop-light");
	} catch (error) {
		retryFailed = true;
		retryError = error;
		try {
			const metadata = await page.evaluate(() =>
				window.__diteroCommentFocus?.stop(),
			);
			if (!metadata) throw new Error("comment focus metadata absent");
			await test.info().attach("focus-diagnostics", {
				body: JSON.stringify(metadata),
				contentType: "application/json",
			});
		} catch {
			test.info().annotations.push({
				type: "secondary-focus-diagnostic",
				description: "Focus metadata capture failed",
			});
		}
	} finally {
		try {
			await page.evaluate(() => window.__diteroCommentFocus?.stop());
		} catch (error) {
			retryCleanupFailed = true;
			retryCleanupError = error;
			test.info().annotations.push({
				type: "secondary-focus-cleanup",
				description: "Focus metadata cleanup failed",
			});
		}
	}
	if (retryFailed) throw retryError;
	if (retryCleanupFailed) throw retryCleanupError;
});

test("comment rotation resume never sends a removed deferred file or its captured body", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const { task, composer, send, pendingFile } = await seed(page);
	const connectionString = process.env.E2E_DATABASE_URL;
	if (!connectionString)
		throw new Error("Fresh owned E2E database binding required");
	const snapshot = await exported(page);
	const list = snapshot.data.lists.find((row) => row.id === task.listId);
	const workspace = snapshot.data.workspaces.find(
		(row) => row.id === list?.workspaceId,
	);
	if (!list || !workspace)
		throw new Error("Fresh task/list/workspace positive control missing");
	expect(
		snapshot.data.comments.filter((row) => row.taskId === task.id),
	).toEqual([]);
	let transferRequests = 0;
	const observeTransfer = (request: import("@playwright/test").Request) => {
		const path = new URL(request.url()).pathname;
		if (
			["/api/attachments/reserve", "/api/attachments/finalize"].includes(
				path,
			) ||
			/^\/api\/attachments\/[^/]+\/(?:upload|thumbnail)$/.test(path)
		)
			transferRequests += 1;
	};
	page.on("request", observeTransfer);
	const pool = new Pool({
		connectionString,
		connectionTimeoutMillis: 5000,
		query_timeout: 5000,
	});
	let failed = false;
	let cleanupFailed = false;
	let primary: unknown;
	let cleanupFailure: unknown;
	try {
		// Authoritative branch setup only: real enrolled keys/queued bytes already exist.
		const changed = await pool.query<{ id: string }>(
			`update workspace w set rotation_required=true
    where w.id=$1 and w.owner_id=$2 and not w.rotation_required
    and exists(select 1 from list l join task t on t.list_id=l.id where l.workspace_id=w.id and t.id=$3)
    returning w.id`,
			[workspace.id, workspace.ownerId, task.id],
		);
		expect(changed.rows).toEqual([{ id: workspace.id }]);
		const commentGate = composer.locator("xpath=ancestor::fieldset");
		const blocked = commentGate.getByTestId("attachment-rotation-blocked");
		await expect(blocked).toBeVisible();
		const syncedRotation = page
			.getByTestId("task-attachments")
			.locator("xpath=ancestor::fieldset")
			.getByTestId("attachment-rotation-blocked");
		await expect(syncedRotation).toBeVisible();
		await expect(pendingFile).toBeVisible();
		const checked = page.waitForResponse("**/api/attachments/config");
		await send.click();
		expect((await checked).ok()).toBe(true);
		await expect(blocked).toBeFocused();
		await expect(send).toHaveAttribute("aria-busy", "false");
		await pendingFile
			.getByRole("button", { name: m.attachment_cancel_upload(), exact: true })
			.click();
		await expect(pendingFile).toHaveCount(0);
		await expect(composer).toHaveValue(COMMENT_TEXT);
		await blocked
			.getByRole("button", { name: m.e2e_rotation_action(), exact: true })
			.click();
		const rotation = page.getByTestId("attachment-rotation-dialog");
		await expect(rotation).toBeVisible();
		const rotated = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname ===
					`/api/e2e/workspaces/${workspace.id}/rotate` &&
				response.request().method() === "POST",
		);
		await rotation
			.getByRole("button", {
				name: m.e2e_rotation_confirm_submit(),
				exact: true,
			})
			.click();
		expect((await rotated).ok()).toBe(true);
		// This dialog closes only after rotate() awaited the stored gate.resume action.
		await expect(rotation).toHaveCount(0, { timeout: 20_000 });
		await expect(blocked).toHaveCount(0);
		// Observe the synced false phase before another direct fixture rotation flip.
		await expect(syncedRotation).toHaveCount(0);
		await expect(composer).toHaveValue(COMMENT_TEXT);
		const after = await exported(page);
		expect(after.data.tasks.some((row) => row.id === task.id)).toBe(true);
		expect(after.data.comments.filter((row) => row.taskId === task.id)).toEqual(
			[],
		);
		expect(
			after.data.attachments.filter((row) => row.parentKind === "comment"),
		).toEqual([]);
		expect(transferRequests).toBe(0);
		const proof = await pool.query<{
			rotation_required: boolean;
			comments: number;
			files: number;
		}>(
			`select w.rotation_required,
     (select count(*)::int from comment c where c.task_id=$3) as comments,
     (select count(*)::int from attachment a where a.workspace_id=w.id and a.parent_kind='comment') as files
    from workspace w where w.id=$1 and w.owner_id=$2`,
			[workspace.id, workspace.ownerId, task.id],
		);
		expect(proof.rows).toEqual([
			{ rotation_required: false, comments: 0, files: 0 },
		]);
		await capture(page, "comment-removed-rotation-resumed-desktop-light");

		// The next rotation uses a fresh gate, not the previous local rotation-clear override.
		const detail = page.getByRole("dialog", { name: m.task_detail_title() });
		await detail
			.getByRole("button", { name: m.action_close(), exact: true })
			.click();
		await expect(detail).toHaveCount(0);
		await openDetails(page, task.title);
		await expect(detail).toBeVisible();
		await expect(blocked).toHaveCount(0);
		await expect(pendingFile).toHaveCount(0);
		expect(transferRequests).toBe(0);
		await composer.fill(COMMENT_TEXT);
		await expect(composer).toHaveValue(COMMENT_TEXT);

		// The next deferred send keeps its file but must use the draft edited afterward.
		await commentGate.getByTestId("attachment-input").setInputFiles({
			name: FILE_NAME,
			mimeType: "text/plain",
			buffer: Buffer.from("real encrypted comment file"),
		});
		await expect(pendingFile).toHaveCount(1);
		await expect(
			pendingFile.getByText(m.attachment_ready_to_upload(), { exact: true }),
		).toBeVisible();
		const changedAgain = await pool.query<{ id: string }>(
			`update workspace w set rotation_required=true
    where w.id=$1 and w.owner_id=$2 and not w.rotation_required
    and exists(select 1 from list l join task t on t.list_id=l.id where l.workspace_id=w.id and t.id=$3)
    returning w.id`,
			[workspace.id, workspace.ownerId, task.id],
		);
		expect(changedAgain.rows).toEqual([{ id: workspace.id }]);
		await expect(blocked).toBeVisible();
		await expect(composer).toHaveValue(COMMENT_TEXT);
		const checkedAgain = page.waitForResponse("**/api/attachments/config");
		await send.click();
		expect((await checkedAgain).ok()).toBe(true);
		await expect(blocked).toBeFocused();
		await expect(send).toHaveAttribute("aria-busy", "false");
		const currentDraft = "Updated plan while workspace keys were rotating";
		await composer.fill(currentDraft);
		await expect(pendingFile).toBeVisible();
		await blocked
			.getByRole("button", { name: m.e2e_rotation_action(), exact: true })
			.click();
		await expect(rotation).toBeVisible();
		const rotatedAgain = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname ===
					`/api/e2e/workspaces/${workspace.id}/rotate` &&
				response.request().method() === "POST",
		);
		const committed = page.waitForResponse("**/api/attachments/finalize");
		// Arm only after the second rotation dialog is positively visible.
		await page.evaluate(installCommentFocusDiagnostics);
		await rotation
			.getByRole("button", {
				name: m.e2e_rotation_confirm_submit(),
				exact: true,
			})
			.click();
		expect((await rotatedAgain).ok()).toBe(true);
		expect((await committed).ok()).toBe(true);
		await expect(rotation).toHaveCount(0, { timeout: 20_000 });
		await expect(blocked).toHaveCount(0);
		await expect
			.poll(async () => {
				const finished = await exported(page);
				const comments = finished.data.comments.filter(
					(row) => row.taskId === task.id,
				);
				return {
					bodies: comments.map((row) => row.body),
					files: finished.data.attachments.filter(
						(row) =>
							row.parentKind === "comment" &&
							comments.some((comment) => comment.id === row.parentId),
					).length,
				};
			})
			.toEqual({ bodies: [currentDraft], files: 1 });
		const committedProof = await pool.query<{ body: string; files: number }>(
			`select c.body,
     (select count(*)::int from attachment a where a.parent_kind='comment' and a.parent_id=c.id and a.state='committed') as files
    from comment c where c.task_id=$1`,
			[task.id],
		);
		expect(committedProof.rows).toEqual([{ body: currentDraft, files: 1 }]);
		await expect(pendingFile).toHaveCount(0);
		await expect(composer).toHaveValue("");
		await expect(composer).toBeFocused();

		// A later user choice must survive another real comment/file completion.
		const keptFocusBody = "Keep task title focus during comment upload";
		const keptFocusFileName = "focus-preservation.txt";
		const keptFocusFile = page
			.getByTestId("comment-pending-files")
			.getByRole("listitem")
			.filter({ hasText: keptFocusFileName });
		await composer.fill(keptFocusBody);
		await commentGate.getByTestId("attachment-input").setInputFiles({
			name: keptFocusFileName,
			mimeType: "text/plain",
			buffer: Buffer.from("real encrypted focus preservation file"),
		});
		await expect(keptFocusFile).toHaveCount(1);
		await expect(
			keptFocusFile.getByText(m.attachment_ready_to_upload(), { exact: true }),
		).toBeVisible();
		let releaseFinalize = () => {};
		const heldFinalize = new Promise<void>((resolve) => {
			releaseFinalize = resolve;
		});
		let finalized = () => {};
		let finalizeFailed = (_error: unknown) => {};
		const serverFinalized = new Promise<void>((resolve, reject) => {
			finalized = resolve;
			finalizeFailed = reject;
		});
		await page.route(
			"**/api/attachments/finalize",
			async (route) => {
				try {
					const response = await route.fetch();
					expect(response.ok()).toBe(true);
					finalized();
					await heldFinalize;
					await route.fulfill({ response });
				} catch (error) {
					finalizeFailed(error);
					throw error;
				}
			},
			{ times: 1 },
		);
		const nextCommitted = page.waitForResponse("**/api/attachments/finalize");
		const chosenControl = detail.getByTestId("task-detail-title");
		try {
			await send.click();
			await serverFinalized;
			await expect(composer).toBeDisabled();
			await expect(chosenControl).toBeEnabled();
			await chosenControl.focus();
			await expect(chosenControl).toBeFocused();
		} finally {
			releaseFinalize();
		}
		expect((await nextCommitted).ok()).toBe(true);
		await expect(keptFocusFile).toHaveCount(0);
		await expect(composer).toBeEnabled();
		await expect(composer).toHaveValue("");
		await expect(chosenControl).toBeFocused();
		const retainedComments = (await exported(page)).data.comments.filter(
			(row) => row.taskId === task.id,
		);
		expect(retainedComments.map((row) => row.body).sort()).toEqual(
			[currentDraft, keptFocusBody].sort(),
		);
		const retainedProof = await pool.query<{ body: string; files: number }>(
			`select c.body,
      (select count(*)::int from attachment a where a.parent_kind='comment' and a.parent_id=c.id and a.state='committed') as files
     from comment c where c.task_id=$1 order by c.body`,
			[task.id],
		);
		expect(retainedProof.rows).toEqual(
			[currentDraft, keptFocusBody].sort().map((body) => ({ body, files: 1 })),
		);
	} catch (error) {
		failed = true;
		primary = error;
		try {
			const metadata = await page.evaluate(() =>
				window.__diteroCommentFocus?.stop(),
			);
			if (!metadata) throw new Error("comment focus metadata absent");
			await test.info().attach("focus-diagnostics", {
				body: JSON.stringify(metadata),
				contentType: "application/json",
			});
		} catch (diagnostic) {
			cleanupFailed = true;
			cleanupFailure = diagnostic;
			try {
				await test.info().attach("focus-diagnostic-failure", {
					body: JSON.stringify({
						failed: true,
						errorType:
							diagnostic instanceof Error ? diagnostic.name : "unknown",
					}),
					contentType: "application/json",
				});
			} catch (attachmentFailure) {
				cleanupFailed = true;
				cleanupFailure = attachmentFailure;
			}
		}
	} finally {
		try {
			await page.evaluate(() => window.__diteroCommentFocus?.stop());
		} catch (error) {
			cleanupFailed = true;
			cleanupFailure = error;
		}
		page.off("request", observeTransfer);
		try {
			await pool.end();
		} catch (error) {
			cleanupFailed = true;
			cleanupFailure = error;
		}
	}
	if (failed) throw primary;
	if (cleanupFailed) throw cleanupFailure;
});
