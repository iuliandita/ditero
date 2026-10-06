import { createHash } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import {
	type Download,
	expect,
	type Locator,
	type Page,
	type Route,
	test,
	type WebSocketRoute,
} from "@playwright/test";
import type { PortableExportV2 } from "../../src/domain/portability/v2.ts";
import { m } from "../../src/paraglide/messages.js";
import {
	goToSettings,
	leaveSettings,
	openDetails,
	openMembers,
	openMobileLists,
	openMoreOptions,
	openWorkspaceSwitcher,
	signUp,
	switchWorkspace,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

const ACCOUNT_SECRET = "correct horse battery staple";
const ARCHIVE_SECRET = "separate fictional archive secret";
const TASK_BYTES = "archive task payload, not a task title";
const COMMENT_BYTES = "archive comment payload, not a comment title";
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const deriveTimeout = 30_000;
test.describe.configure({ timeout: 120_000 });
const dialog = (page: Page) =>
	page.getByTestId("attachment-archive-export-dialog");
const inputFor = (scope: Locator) =>
	scope.locator("xpath=ancestor::fieldset").getByTestId("attachment-input");

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
async function seed(page: Page, extras = true, signup = true) {
	if (signup) await signUp(page, uniqueEmail("archive-export"));
	await waitWorkspaceReady(page);
	if ((page.viewportSize()?.width ?? 1280) < 768) await openMobileLists(page);
	const listName = `Archive household ${Date.now()}`;
	const taskName = "Keep the household receipts";
	if ((page.viewportSize()?.width ?? 1280) < 768)
		await page.getByRole("button", { name: "New list", exact: true }).click();
	else await page.getByTestId("create-list-open").click();
	await page.getByTestId("new-list").fill(listName);
	await page.getByTestId("new-list-submit").click();
	if ((page.viewportSize()?.width ?? 1280) < 768) {
		await page
			.getByTestId("list-index")
			.getByText(listName, { exact: true })
			.click();
	} else {
		await page
			.locator('nav[aria-label="Lists"]')
			.getByRole("button", { name: listName, exact: true })
			.first()
			.click();
	}
	await page.getByTestId("new-task").fill(taskName);
	await page.getByTestId("new-task-submit").click();
	await openDetails(page, taskName);
	const detail = page.getByRole("dialog", { name: m.task_detail_title() });
	await openMoreOptions(detail);
	const committed = page.waitForResponse("**/api/attachments/finalize");
	await inputFor(page.getByTestId("task-attachments")).setInputFiles({
		name: "task-note.txt",
		mimeType: "text/plain",
		buffer: Buffer.from(TASK_BYTES),
	});
	await enroll(page);
	expect((await committed).ok()).toBe(true);
	await expect(
		page.getByTestId("task-attachments").getByRole("button", {
			name: m.attachment_open_named({ name: "task-note.txt" }),
			exact: true,
		}),
	).toBeVisible({ timeout: 20000 });
	if (extras) {
		const composer = page.getByTestId("comment-input");
		await inputFor(composer).setInputFiles({
			name: "comment-note.txt",
			mimeType: "text/plain",
			buffer: Buffer.from(COMMENT_BYTES),
		});
		const pending = page
			.getByTestId("comment-pending-files")
			.getByRole("listitem")
			.filter({ hasText: "comment-note.txt" });
		await expect(pending).toHaveCount(1);
		await expect(pending).toBeVisible();
		await expect(
			pending.getByText(m.attachment_ready_to_upload(), { exact: true }),
		).toBeVisible();
		await composer.fill("Receipt reference");
		const saved = page.waitForResponse("**/api/attachments/finalize");
		await page.getByTestId("comment-submit").click();
		expect((await saved).ok()).toBe(true);
		await expect(
			page
				.getByTestId("comment-item")
				.filter({ hasText: "Receipt reference" })
				.getByRole("button", {
					name: m.attachment_open_named({ name: "comment-note.txt" }),
					exact: true,
				}),
		).toBeVisible({ timeout: 20000 });
	}
	await detail.getByRole("button", { name: m.modal_close_label() }).click();
	await expect(detail).toHaveCount(0);
	if (extras) {
		const chooser = page.waitForEvent("filechooser");
		await page.getByTestId("list").getByTestId("row-actions").first().click();
		await page.getByTestId("row-action-attachment-add").click();
		const saved = page.waitForResponse("**/api/attachments/finalize");
		await (await chooser).setFiles({
			name: "list-image.png",
			mimeType: "image/png",
			buffer: Buffer.from(PNG, "base64"),
		});
		expect((await saved).ok()).toBe(true);
	}
	await expect
		.poll(async () => {
			const response = await page.request.get(
				"/api/portability/export?version=2",
			);
			expect(response.ok()).toBe(true);
			const value: PortableExportV2 = await response.json();
			return value.data.attachments.length;
		})
		.toBe(extras ? 3 : 1);
	return { listName, taskName };
}
async function capture(page: Page, name: string) {
	const path = test.info().outputPath(`${name}.png`);
	await page.screenshot({ path, fullPage: false });
	await test.info().attach(name, { path, contentType: "image/png" });
}
async function a11y(page: Page) {
	const { violations } = await new AxeBuilder({ page })
		.include('[data-testid="attachment-archive-export-dialog"]')
		.analyze();
	expect(
		violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
	).toEqual([]);
}
async function read(download: Download) {
	const parts: Buffer[] = [];
	for await (const part of await download.createReadStream())
		parts.push(Buffer.from(part));
	return Buffer.concat(parts).toString("utf8");
}
async function pair(page: Page, touch = false) {
	let leaked = false;
	const observe = (request: import("@playwright/test").Request) => {
		const body = request.postData() ?? "";
		leaked ||= [ARCHIVE_SECRET, TASK_BYTES, COMMENT_BYTES].some(
			(value) => body.includes(value) || request.url().includes(value),
		);
	};
	page.on("request", observe);
	const surface = dialog(page);
	const filename = surface.getByText("task-note.txt", { exact: true });
	await expect(filename).toBeVisible({ timeout: deriveTimeout });
	const task = surface.getByRole("checkbox", {
		name: "task-note.txt",
		exact: true,
	});
	const image = surface.getByRole("checkbox", {
		name: "list-image.png",
		exact: true,
	});
	if (touch) {
		await task.tap();
		await image.tap();
	} else {
		await task.check();
		await image.check();
	}
	await expect(
		surface.getByRole("checkbox", { name: "comment-note.txt", exact: true }),
	).not.toBeChecked();
	const fields = surface.locator('input[type="password"]');
	await fields.nth(0).fill(ARCHIVE_SECRET);
	await fields.nth(1).fill("not the archive secret");
	await expect(
		surface.getByRole("button", { name: "Prepare archive", exact: true }),
	).toBeDisabled();
	await expect(
		surface.getByText("The passphrases do not match.", { exact: true }),
	).toBeVisible();
	await fields.nth(1).fill(ARCHIVE_SECRET);
	const prepare = surface.getByRole("button", {
		name: "Prepare archive",
		exact: true,
	});
	await expect(prepare).toBeEnabled();
	if (touch) await prepare.tap();
	else {
		await prepare.focus();
		await page.keyboard.press("Enter");
	}
	const content = surface.getByRole("button", {
		name: "Download content",
		exact: true,
	});
	await expect(content).toBeVisible({ timeout: deriveTimeout });
	if (!touch) await expect(content).toBeFocused();
	await expect(
		surface.getByRole("button", { name: "Prepare archive", exact: true }),
	).toHaveCount(0);
	await a11y(page);
	const first = page.waitForEvent("download");
	if (touch) await content.tap();
	else await content.click();
	const contentDownload = await first;
	const second = page.waitForEvent("download");
	const filesButton = surface.getByRole("button", {
		name: "Download files",
		exact: true,
	});
	if (touch) await filesButton.tap();
	else await filesButton.click();
	const filesDownload = await second;
	const id = /^ditero-content-([0-9a-f-]{36})\.json$/.exec(
		contentDownload.suggestedFilename(),
	)?.[1];
	expect(id).toBeTruthy();
	expect(filesDownload.suggestedFilename()).toBe(`ditero-files-${id}.json`);
	for (const filename of [
		contentDownload.suggestedFilename(),
		filesDownload.suggestedFilename(),
	]) {
		const status = surface.getByRole("status").filter({ hasText: filename });
		await expect(status).toHaveCount(1);
		await expect(
			status.getByText("Download requested. Check your browser downloads.", {
				exact: true,
			}),
		).toBeVisible();
	}
	await capture(
		page,
		touch ? "archive-paired-mobile-dark" : "archive-paired-desktop-light",
	);
	expect(leaked).toBe(false);
	page.off("request", observe);
	return {
		content: await read(contentDownload),
		files: await read(filesDownload),
	};
}
async function authenticate(page: Page, content: string, files: string) {
	const result = await page.evaluate(
		async ({ content, files, secret, png }) => {
			const archivePath = "/src/web/lib/e2e/attachment-archive.ts";
			const streamPath = "/src/domain/e2e/stream.ts";
			const wirePath = "/src/domain/e2e/wire.ts";
			const { openAttachmentArchive } = (await import(
				archivePath
			)) as typeof import("../../src/web/lib/e2e/attachment-archive.ts");
			const { decryptStream } = (await import(
				streamPath
			)) as typeof import("../../src/domain/e2e/stream.ts");
			const { decodeBytes } = (await import(
				wirePath
			)) as typeof import("../../src/domain/e2e/wire.ts");
			const opened = await openAttachmentArchive(files, content, secret);
			async function* source(value: Uint8Array) {
				yield value;
			}
			async function hash(value: Uint8Array) {
				return Array.from(
					new Uint8Array(
						await crypto.subtle.digest("SHA-256", new Uint8Array(value)),
					),
					(b) => b.toString(16).padStart(2, "0"),
				).join("");
			}
			const payloads: { kind: string; sha256: string; thumbnail: boolean }[] =
				[];
			let protectedKeys = true;
			let pngMatches = false;
			for (const entry of opened.manifest.entries) {
				const object = opened.archive.objects.find(
					(value) => value.entryId === entry.entryId,
				);
				if (!object) throw new Error("missing object");
				const dek = decodeBytes(entry.locallyExportedDek);
				const parts: Uint8Array[] = [];
				try {
					protectedKeys &&= !files.includes(entry.locallyExportedDek);
					for await (const part of decryptStream(
						source(decodeBytes(object.content)),
						dek,
						"content",
					))
						parts.push(part);
					const plain = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
					let at = 0;
					try {
						for (const part of parts) {
							plain.set(part, at);
							at += part.length;
						}
						payloads.push({
							kind: entry.source.parentKind,
							sha256: await hash(plain),
							thumbnail: entry.thumbnail !== null,
						});
						if (entry.source.parentKind === "list") {
							const expected = Uint8Array.from(atob(png), (c) =>
								c.charCodeAt(0),
							);
							const actualBitmap = await createImageBitmap(
								new Blob([plain], { type: "image/png" }),
							);
							const expectedBitmap = await createImageBitmap(
								new Blob([expected], { type: "image/png" }),
							);
							try {
								const pixels = (bitmap: ImageBitmap) => {
									const canvas = document.createElement("canvas");
									canvas.width = 1;
									canvas.height = 1;
									const context = canvas.getContext("2d");
									if (!context) throw new Error("missing pixel decoder");
									context.drawImage(bitmap, 0, 0);
									const data = context.getImageData(0, 0, 1, 1).data;
									try {
										return Array.from(data).join(",");
									} finally {
										data.fill(0);
										canvas.width = 0;
										canvas.height = 0;
									}
								};
								pngMatches =
									actualBitmap.width === 1 &&
									actualBitmap.height === 1 &&
									expectedBitmap.width === 1 &&
									expectedBitmap.height === 1 &&
									pixels(actualBitmap) === pixels(expectedBitmap);
							} finally {
								actualBitmap.close();
								expectedBitmap.close();
								expected.fill(0);
							}
						}
					} finally {
						plain.fill(0);
					}
				} finally {
					dek.fill(0);
					for (const part of parts) part.fill(0);
				}
			}
			let wrongSecretRefused = false;
			let alteredDocumentRefused = false;
			try {
				await openAttachmentArchive(
					files,
					content,
					"wrong fictional archive secret",
				);
			} catch {
				wrongSecretRefused = true;
			}
			try {
				await openAttachmentArchive(files, `${content}\n`, secret);
			} catch {
				alteredDocumentRefused = true;
			}
			return {
				count: opened.archive.objects.length,
				payloads,
				protectedKeys,
				pngMatches,
				wrongSecretRefused,
				alteredDocumentRefused,
			};
		},
		{ content, files, secret: ARCHIVE_SECRET, png: PNG },
	);
	expect(result.count).toBe(2);
	expect(result.protectedKeys).toBe(true);
	expect(result.pngMatches).toBe(true);
	expect(result.wrongSecretRefused).toBe(true);
	expect(result.alteredDocumentRefused).toBe(true);
	expect(result.payloads).toContainEqual({
		kind: "task",
		sha256: createHash("sha256").update(TASK_BYTES).digest("hex"),
		thumbnail: false,
	});
	expect(result.payloads).toContainEqual({
		kind: "list",
		sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
		thumbnail: true,
	});
	expect(files).not.toContain("task-note.txt");
	expect(files).not.toContain("list-image.png");
	expect(files).not.toContain(TASK_BYTES);
	expect(files).not.toContain(COMMENT_BYTES);
	expect(files).not.toContain(ARCHIVE_SECRET);
	expect(files).not.toContain(ACCOUNT_SECRET);
	const saved: PortableExportV2 = JSON.parse(content);
	expect(saved.boundaries.attachmentContent).toBe("excluded");
	expect(saved.boundaries.restoreSupported).toBe(false);
	expect(saved.data.attachments.map((row) => row.parentKind).sort()).toEqual([
		"comment",
		"list",
		"task",
	]);
}

test("archive export: locked desktop keys and two authenticated explicit downloads", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await seed(page);
	await goToSettings(page);
	await page.getByTestId("theme-switcher").click();
	await page.getByRole("option", { name: "Light", exact: true }).click();
	await page.getByTestId("e2e-lock-now").click();
	let exports = 0;
	let downloads = 0;
	page.on("request", (request) => {
		if (new URL(request.url()).pathname === "/api/portability/export")
			exports++;
	});
	page.on("download", () => downloads++);
	await page
		.getByRole("button", { name: "Export selected files", exact: true })
		.click();
	await expect(
		dialog(page).getByText("Unlock encrypted files first.", { exact: false }),
	).toBeVisible();
	await expect(
		dialog(page).getByText("task-note.txt", { exact: true }),
	).toHaveCount(0);
	expect(exports).toBe(0);
	expect(downloads).toBe(0);
	await a11y(page);
	await capture(page, "archive-locked-desktop-light");
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
	const response = page.waitForResponse(exportURL).then(
		(actual) => ({ actual }),
		(error: unknown) => ({ error }),
	);
	await dialog(page)
		.getByRole("button", { name: m.e2e_unlock_submit(), exact: true })
		.click();
	await page.getByTestId("e2e-unlock-passphrase").fill(ACCOUNT_SECRET);
	await page.getByTestId("e2e-unlock-submit").click();
	await expect(page.getByTestId("e2e-unlock-dialog")).toHaveCount(0, {
		timeout: deriveTimeout,
	});
	const captureResult = await captured;
	if ("error" in captureResult) throw captureResult.error;
	const browserResult = await response;
	if ("error" in browserResult) throw browserResult.error;
	expect(browserResult.actual.ok()).toBe(true);
	const exact = captureResult.body;
	await expect(
		dialog(page).getByText("list-image.png", { exact: true }),
	).toBeVisible({ timeout: deriveTimeout });
	await capture(page, "archive-selection-desktop-light");
	expect(downloads).toBe(0);
	const artifact = await pair(page);
	expect(artifact.content).toBe(exact);
	expect(downloads).toBe(2);
	await authenticate(page, artifact.content, artifact.files);
	await dialog(page)
		.getByRole("button", { name: "Close", exact: true })
		.and(dialog(page).locator('[data-slot="button"]'))
		.click();
	await expect(dialog(page)).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Export selected files", exact: true }),
	).toBeFocused();
});

test("archive export: coarse mobile dark selection, geometry and authenticated pair", async ({
	browser,
}) => {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
		colorScheme: "dark",
	});
	try {
		const page = await context.newPage();
		await seed(page);
		await goToSettings(page);
		await page.getByTestId("theme-switcher").click();
		await page.getByRole("option", { name: "Dark", exact: true }).click();
		await expect(page.locator("html")).toHaveClass(/dark/);
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
		const response = page.waitForResponse(exportURL).then(
			(actual) => ({ actual }),
			(error: unknown) => ({ error }),
		);
		await page
			.getByRole("button", { name: "Export selected files", exact: true })
			.tap();
		const captureResult = await captured;
		if ("error" in captureResult) throw captureResult.error;
		await expect(
			dialog(page).getByText("list-image.png", { exact: true }),
		).toBeVisible({ timeout: deriveTimeout });
		const browserResult = await response;
		if ("error" in browserResult) throw browserResult.error;
		expect(browserResult.actual.ok()).toBe(true);
		const exact = captureResult.body;
		expect(
			await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
		).toBe(true);
		const box = await dialog(page).boundingBox();
		if (!box) throw new Error("missing dialog geometry");
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(390);
		const dimensions = await dialog(page).evaluate((element) => ({
			scroll: element.scrollWidth,
			client: element.clientWidth,
		}));
		expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
		for (const control of await dialog(page)
			.locator(
				'button:not([role="checkbox"]),input[type="password"],label[for*="-file-"]',
			)
			.all()) {
			const b = await control.boundingBox();
			if (!b) throw new Error("missing control geometry");
			expect(b.height).toBeGreaterThanOrEqual(44);
		}
		const checkbox = dialog(page).getByRole("checkbox", {
			name: "task-note.txt",
			exact: true,
		});
		const hit = await checkbox.evaluate((element) => {
			const style = getComputedStyle(element, "::after");
			const wrapper = element.parentElement?.getBoundingClientRect();
			return {
				width: style.width,
				height: style.height,
				wrapperWidth: wrapper?.width,
				wrapperHeight: wrapper?.height,
			};
		});
		expect(hit).toEqual({
			width: "44px",
			height: "44px",
			wrapperWidth: 44,
			wrapperHeight: 44,
		});
		await a11y(page);
		await capture(page, "archive-selection-mobile-dark");
		const artifact = await pair(page, true);
		expect(artifact.content).toBe(exact);
		expect(
			await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
		).toBe(true);
		await authenticate(page, artifact.content, artifact.files);
	} finally {
		await context.close();
	}
});

async function pushHold(page: Page) {
	let holding = false;
	const held: { server: WebSocketRoute; message: string | Buffer }[] = [];
	let count = 0;
	await page.routeWebSocket(/\/sync\/v\d+\/connect/, (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			const value: unknown = JSON.parse(message.toString());
			if (holding && Array.isArray(value) && value[0] === "push") {
				held.push({ server, message });
				count++;
			} else server.send(message);
		});
	});
	return {
		hold() {
			holding = true;
		},
		get count() {
			return count;
		},
		release() {
			holding = false;
			for (const { server, message } of held.splice(0)) server.send(message);
		},
	};
}

test("archive export: accepted writes wait and closing cancels a real content response", async ({
	page,
}) => {
	const hold = await pushHold(page);
	const f = await seed(page, false);
	let exports = 0;
	let downloads = 0;
	page.on("request", (r) => {
		if (new URL(r.url()).pathname === "/api/portability/export") exports++;
	});
	page.on("download", () => downloads++);
	hold.hold();
	try {
		await page.getByTestId("new-task").fill("Receipt accepted locally");
		await page.getByTestId("new-task-submit").click();
		await expect(
			page
				.getByTestId("list")
				.getByText("Receipt accepted locally", { exact: true }),
		).toBeVisible();
		await expect.poll(() => hold.count).toBeGreaterThan(0);
		await goToSettings(page);
		await page
			.getByRole("button", { name: "Export selected files", exact: true })
			.click();
		await expect(
			dialog(page).getByText(
				"Waiting for saved changes and checking available files...",
				{ exact: true },
			),
		).toBeVisible();
		expect(exports).toBe(0);
		expect(downloads).toBe(0);
		await dialog(page)
			.getByRole("button", { name: "Close", exact: true })
			.and(dialog(page).locator('[data-slot="button"]'))
			.click();
		await expect(dialog(page)).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Export selected files", exact: true }),
		).toBeFocused();
	} finally {
		hold.release();
	}
	await expect
		.poll(async () => {
			const r = await page.request.get("/api/portability/export?version=2");
			expect(r.ok()).toBe(true);
			const v: PortableExportV2 = await r.json();
			return v.data.tasks.some(
				(task) => task.title === "Receipt accepted locally",
			);
		})
		.toBe(true);
	let release = () => {};
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	let reached = () => {};
	const ready = new Promise<void>((resolve) => {
		reached = resolve;
	});
	await page.route("**/api/portability/export?version=2", async (route) => {
		const actual = await route.fetch();
		expect(actual.ok()).toBe(true);
		reached();
		await barrier;
		await route.fulfill({ response: actual }).catch(() => undefined);
	});
	try {
		await page
			.getByRole("button", { name: "Export selected files", exact: true })
			.click();
		await ready;
		await dialog(page)
			.getByRole("button", { name: "Close", exact: true })
			.and(dialog(page).locator('[data-slot="button"]'))
			.click();
		release();
		await expect(dialog(page)).toHaveCount(0);
		expect(downloads).toBe(0);
	} finally {
		release();
		await page.unroute("**/api/portability/export?version=2");
	}
	await page
		.getByRole("button", { name: "Export selected files", exact: true })
		.click();
	await expect(
		dialog(page).getByText("task-note.txt", { exact: true }),
	).toBeVisible({ timeout: deriveTimeout });
	await expect(
		dialog(page).locator('input[type="password"]').first(),
	).toHaveValue("");
	expect(f.listName).toContain("Archive household");
});

test("archive export: a real shared file without its key is explained and unselectable", async ({
	browser,
}) => {
	test.setTimeout(180000);
	const ownerContext = await browser.newContext();
	const memberContext = await browser.newContext();
	try {
		const owner = await ownerContext.newPage();
		const member = await memberContext.newPage();
		const email = uniqueEmail("archive-member");
		await signUp(owner, uniqueEmail("archive-owner"));
		await openWorkspaceSwitcher(owner);
		await owner.getByTestId("create-workspace").click();
		await owner
			.getByTestId("create-workspace-name")
			.fill("Fictional archive household");
		await owner.getByTestId("create-workspace-submit").click();
		await expect(owner.getByTestId("create-workspace-dialog")).toHaveCount(0);
		await expect(owner.getByTestId("workspace-switcher")).toContainText(
			"Fictional archive household",
		);
		await seed(owner, false, false);
		await goToSettings(owner);
		await owner.getByTestId("e2e-lock-now").click();
		await leaveSettings(owner);
		await openMembers(owner);
		await owner.getByTestId("invite-open").click();
		await owner.getByTestId("invite-email").fill(email);
		await owner.getByTestId("invite-submit").click();
		const link = owner.getByTestId("invite-link");
		await expect(link).toBeVisible();
		const token = new URL(await link.inputValue()).searchParams.get("token");
		if (!token) throw new Error("missing invitation token");
		await signUp(member, email);
		await goToSettings(member);
		await member.getByTestId("e2e-setup").click();
		await enroll(member);
		await leaveSettings(member);
		await member.goto(
			new URL(`/accept?token=${encodeURIComponent(token)}`, member.url()).href,
		);
		const navigation = member.waitForURL(new URL("/", member.url()).href, {
			waitUntil: "domcontentloaded",
		});
		await member.getByTestId("accept-join").click();
		await navigation;
		await waitWorkspaceReady(member);
		await switchWorkspace(member, "Fictional archive household");
		const saved = await member.request.get("/api/portability/export?version=2");
		expect(saved.ok()).toBe(true);
		const value: PortableExportV2 = await saved.json();
		expect(value.data.attachments).toHaveLength(1);
		let gets = 0;
		member.on("request", (r) => {
			if (
				/\/api\/attachments\/[^/]+\/(download|thumbnail)$/.test(
					new URL(r.url()).pathname,
				)
			)
				gets++;
		});
		await goToSettings(member);
		await member
			.getByRole("button", { name: "Export selected files", exact: true })
			.click();
		const unavailable = dialog(member).getByRole("checkbox", {
			name: "Unavailable file",
			exact: true,
		});
		await expect(unavailable).toBeDisabled({ timeout: deriveTimeout });
		await expect(unavailable).toHaveAttribute("aria-describedby", /reason/);
		await expect(
			dialog(member).getByText(
				"The key or matching saved metadata is unavailable. This file cannot be selected.",
				{ exact: true },
			),
		).toBeVisible();
		await expect(
			dialog(member).getByText("task-note.txt", { exact: true }),
		).toHaveCount(0);
		await expect(
			dialog(member).getByRole("button", {
				name: "Prepare archive",
				exact: true,
			}),
		).toBeDisabled();
		expect(gets).toBe(0);
		await a11y(member);
	} finally {
		await ownerContext.close();
		await memberContext.close();
	}
});

test("archive export: explicit paging preserves selection and refuses a 65th selected file", async ({
	page,
}) => {
	const { taskName } = await seed(page, false);
	await openDetails(page, taskName);
	const detail = page.getByRole("dialog", { name: m.task_detail_title() });
	await openMoreOptions(detail);
	await inputFor(page.getByTestId("task-attachments")).setInputFiles(
		Array.from({ length: 64 }, (_, index) => ({
			name: `paging-${String(index).padStart(2, "0")}.txt`,
			mimeType: "text/plain",
			buffer: Buffer.from(`Fictional receipt ${index}`),
		})),
	);
	// The normal sequential uploader must commit every row before leaving its owner.
	await expect
		.poll(
			async () => {
				const response = await page.request.get(
					"/api/portability/export?version=2",
				);
				expect(response.ok()).toBe(true);
				const value: PortableExportV2 = await response.json();
				return value.data.attachments.length;
			},
			{ timeout: 60_000 },
		)
		.toBe(65);
	await expect(
		page.getByTestId("task-attachments").getByRole("button", {
			name: m.attachment_open_named({ name: "paging-63.txt" }),
			exact: true,
		}),
	).toBeVisible();
	await detail.getByRole("button", { name: m.modal_close_label() }).click();
	await expect(detail).toHaveCount(0);
	await goToSettings(page);
	let metadataReads = 0;
	let contentReads = 0;
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (request.method() === "GET" && path === "/api/e2e/keys/mine")
			metadataReads++;
		if (/\/api\/attachments\/[^/]+\/(download|thumbnail)$/.test(path))
			contentReads++;
	});
	await page
		.getByRole("button", { name: "Export selected files", exact: true })
		.click();
	const surface = dialog(page);
	const files = surface.getByRole("checkbox");
	const more = surface.getByRole("button", {
		name: "Load more files",
		exact: true,
	});
	await expect(files).toHaveCount(64, { timeout: deriveTimeout });
	await expect(more).toBeEnabled();
	// A completed first page, not a sleep, establishes the read boundary.
	expect(metadataReads).toBe(64);
	expect(contentReads).toBe(0);
	// Accessible names come from labels, so pin the existing checkbox identity instead.
	const retainedId = await files.first().getAttribute("id");
	if (!retainedId) throw new Error("missing first-page checkbox identity");
	await files.first().check();
	await more.click();
	await expect(files).toHaveCount(65, { timeout: deriveTimeout });
	await expect(more).toHaveCount(0);
	expect(metadataReads).toBe(65);
	expect(contentReads).toBe(0);
	const retained = surface.locator(`[id="${retainedId}"]`);
	await expect(retained).toBeChecked();
	for (const checkbox of (await files.all()).slice(1, 64))
		await checkbox.check();
	await expect(
		surface.locator('[role="checkbox"][aria-checked="true"]'),
	).toHaveCount(64);
	await expect(files.nth(64)).toBeDisabled();
	await expect(
		surface.getByText(
			"Choose up to 64 files. The archive allows 16 MiB of encrypted file data and 32 KiB of protected metadata; some selections may reach the limit sooner.",
			{ exact: true },
		),
	).toBeVisible();
	// Positive control: releasing one seat makes the final real file selectable.
	await retained.uncheck();
	await expect(files.nth(64)).toBeEnabled();
	await files.nth(64).check();
	await expect(
		surface.locator('[role="checkbox"][aria-checked="true"]'),
	).toHaveCount(64);
	expect(contentReads).toBe(0);
});
