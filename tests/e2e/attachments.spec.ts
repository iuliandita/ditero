import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { m } from "../../src/paraglide/messages.js";
import { signUp, uniqueEmail, waitWorkspaceReady } from "./helpers.ts";

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

async function finishEnrollment(page: Page, filename: string): Promise<void> {
	await expect(page.getByTestId("e2e-enroll-dialog")).toBeVisible();
	await page.getByTestId("e2e-passphrase").fill(PASSPHRASE);
	await page.getByTestId("e2e-passphrase-confirm").fill(PASSPHRASE);
	await page.getByTestId("e2e-enroll-continue").click();
	const recovery = page.getByTestId("e2e-recovery-code");
	await expect(recovery).toBeVisible({ timeout: DERIVE_TIMEOUT });
	const code = (await recovery.innerText()).replace(/\s+/g, "-");
	await page.getByTestId("e2e-recovery-confirm").fill(code);
	await page.getByTestId("e2e-recovery-submit").click();
	await expect(page.getByTestId("e2e-enroll-pending-upload")).toContainText(
		filename,
		{ timeout: DERIVE_TIMEOUT },
	);
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
