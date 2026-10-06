import { expect, type Page, type Route, test } from "@playwright/test";
import type { PortableExportV2 } from "../../src/domain/portability/v2.ts";
import { m } from "../../src/paraglide/messages.js";
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

test("comment submission blocks repeated Send while real configuration is pending", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await signUp(page, uniqueEmail("comment-selection"));
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
	let submitConfigRequests = 0;
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let reached!: () => void;
	let requestFailed!: (error: unknown) => void;
	const observed = new Promise<void>((resolve, reject) => {
		reached = resolve;
		requestFailed = reject;
	});
	void observed.catch(() => undefined);
	let delivered!: () => void;
	let deliveryFailed!: (error: unknown) => void;
	const delivery = new Promise<void>((resolve, reject) => {
		delivered = resolve;
		deliveryFailed = reject;
	});
	void delivery.catch(() => undefined);
	async function waitForDelivery() {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				delivery,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() =>
							reject(new Error("Held configuration delivery did not finish")),
						5_000,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	const holdConfig = async (route: Route) => {
		submitConfigRequests += 1;
		try {
			const response = await route.fetch();
			expect(response.ok()).toBe(true);
			reached();
			await held;
			await route.fulfill({ response });
			delivered();
		} catch (error) {
			requestFailed(error);
			deliveryFailed(error);
		}
	};
	await page.route("**/api/attachments/config", holdConfig);
	const committed = page.waitForResponse("**/api/attachments/finalize");
	let primaryFailed = false;
	let cleanupFailure: unknown;
	try {
		await send.click();
		await observed;
		await expect(send).toBeDisabled();
		await expect(composer).toBeDisabled();
		await expect(send).toHaveAttribute("aria-busy", "true");
		const statusId = await send.getAttribute("aria-describedby");
		expect(statusId).toBeTruthy();
		await expect(page.locator(`[id=${JSON.stringify(statusId)}]`)).toHaveText(
			m.comment_sending(),
		);
		await expect(pendingFile).toBeVisible();
		await expect(
			pendingFile.getByRole("button", {
				name: m.attachment_cancel_upload(),
				exact: true,
			}),
		).toHaveCount(0);
		const box = await send.boundingBox();
		if (!box) throw new Error("Visible Send positive control missing");
		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
		expect(submitConfigRequests).toBe(1);
		await expect(page.getByTestId("comment-item")).toHaveCount(0);
		const during = await exported(page);
		expect(during.data.tasks.some((row) => row.id === task.id)).toBe(true);
		expect(
			during.data.comments.filter((row) => row.taskId === task.id),
		).toEqual([]);
		await capture(page, "comment-submit-checking-desktop-light");
		release();
		await waitForDelivery();
		expect((await committed).ok()).toBe(true);
		const comment = page
			.getByTestId("comment-item")
			.filter({ hasText: COMMENT_TEXT });
		await expect(comment).toHaveCount(1);
		await expect(
			comment.getByRole("button", {
				name: m.attachment_open_named({ name: FILE_NAME }),
				exact: true,
			}),
		).toBeVisible({ timeout: 20_000 });
		await expect
			.poll(async () => {
				const after = await exported(page);
				const saved = after.data.comments.filter(
					(row) => row.taskId === task.id && row.body === COMMENT_TEXT,
				);
				return {
					comments: saved.length,
					files: after.data.attachments.filter(
						(row) =>
							row.parentKind === "comment" &&
							saved.some((comment) => comment.id === row.parentId),
					).length,
				};
			})
			.toEqual({ comments: 1, files: 1 });
		await expect(composer).toBeEnabled();
		await expect(composer).toBeFocused();
		await expect(send).toHaveAttribute("aria-busy", "false");
		await capture(page, "comment-submit-completed-desktop-light");
	} catch (error) {
		primaryFailed = true;
		throw error;
	} finally {
		release();
		if (submitConfigRequests > 0) {
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
			await page.unroute("**/api/attachments/config", holdConfig);
		} catch (error) {
			cleanupFailure ??= error;
			test.info().annotations.push({
				type: "secondary-cleanup-error",
				description:
					error instanceof Error ? error.name : "Unknown cleanup error",
			});
		}
	}
	if (!primaryFailed && cleanupFailure) throw cleanupFailure;
});
