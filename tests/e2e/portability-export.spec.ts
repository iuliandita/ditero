import AxeBuilder from "@axe-core/playwright";
import {
	type Download,
	expect,
	type Page,
	test,
	type WebSocketRoute,
} from "@playwright/test";
import type { PortableExportV2 } from "../../src/domain/portability/v2.ts";
import {
	goToSettings,
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

test("downloads a versioned account export with explicit limits", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("export"));
	await waitWorkspaceReady(page);
	await goToSettings(page);
	const panel = page.getByRole("region", { name: "Export your data" });
	await expect(panel).toContainText("not a complete restorable backup");
	const screenshotPath = test.info().outputPath("data-export-settings.png");
	await panel.screenshot({ path: screenshotPath });
	await test.info().attach("data-export-settings", {
		path: screenshotPath,
		contentType: "image/png",
	});
	const downloadPromise = page.waitForEvent("download");
	await panel.getByRole("button", { name: "Download JSON" }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe("ditero-history-v2.json");
	await expect(panel.getByRole("status")).toHaveText(
		"Download requested. Check your browser downloads.",
	);
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	const exported = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	expect(exported.format).toBe("ditero");
	expect(exported.schemaVersion).toBe(2);
	expect(exported.boundaries.attachmentContent).toBe("excluded");
	expect(exported.boundaries.restoreSupported).toBe(false);
	expect(exported.data.workspaces).toHaveLength(1);
	expect(exported.data.memberships[0].userId).toBe(exported.sourceUserId);
	expect(exported.data.principals).toEqual([
		expect.objectContaining({ id: exported.sourceUserId }),
	]);
	const { violations } = await new AxeBuilder({ page })
		.include("#data-portability")
		.analyze();
	expect(violations).toEqual([]);
});

test("shows a size refusal and allows retry", async ({ page }) => {
	await signUp(page, uniqueEmail("export-limit"));
	await waitWorkspaceReady(page);
	await goToSettings(page);
	await page.route("**/api/portability/export?version=2", (route) =>
		route.fulfill({ status: 413 }),
	);
	const button = page.getByRole("button", { name: "Download JSON" });
	await button.click();
	await expect(page.getByRole("alert")).toHaveText(
		"This export exceeds the download limit. No partial file was created.",
	);
	await expect(button).toBeEnabled();
	await page.unroute("**/api/portability/export?version=2");
	const download = page.waitForEvent("download");
	await button.click();
	await download;
	await expect(page.getByRole("alert")).toHaveCount(0);
});

// Forward the real protocol in both directions, holding only actual mutation pushes.
async function installPushHold(page: Page) {
	let holding = false;
	let heldCount = 0;
	const held: { server: WebSocketRoute; message: string | Buffer }[] = [];
	await page.routeWebSocket(/\/sync\/v\d+\/connect/, (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			const parsed: unknown = JSON.parse(message.toString());
			if (holding && Array.isArray(parsed) && parsed[0] === "push") {
				held.push({ server, message });
				heldCount++;
			} else server.send(message);
		});
	});
	return {
		hold() {
			holding = true;
		},
		get count() {
			return heldCount;
		},
		release() {
			holding = false;
			for (const { server, message } of held.splice(0)) server.send(message);
		},
	};
}

async function savedList(page: Page, name: string) {
	await signUp(page, uniqueEmail("export-pending"));
	await waitWorkspaceReady(page);
	await page.getByTestId("sidebar-create").click();
	await page.getByTestId("sidebar-new-list").click();
	await expect(page.getByTestId("new-list")).toBeFocused();
	await page.getByTestId("new-list").fill(name);
	await page.getByTestId("new-list-submit").click();
	await sidebarLists(page)
		.getByRole("button", { name, exact: true })
		.last()
		.click();
	await expect(page.getByTestId("list")).toBeVisible();
	await expect(page.getByTestId("sync-indicator")).toHaveAttribute(
		"data-phase",
		"synced",
		{ timeout: 15000 },
	);
	// Read the real saved snapshot before holding any push, proving setup persisted.
	const response = await page.request.get("/api/portability/export?version=2");
	expect(response.ok()).toBe(true);
	const saved: PortableExportV2 = await response.json();
	expect(saved.data.lists.some((list) => list.title === name)).toBe(true);
}

async function optimisticTask(page: Page, title: string) {
	await page.getByTestId("new-task").fill(title);
	await page.getByTestId("new-task-submit").click();
	await expect(
		page.getByTestId("list").getByText(title, { exact: true }),
	).toBeVisible();
}

function exportEvents(page: Page) {
	const requests: string[] = [];
	const downloads: Download[] = [];
	page.on("request", (request) => {
		if (
			request.method() === "GET" &&
			new URL(request.url()).pathname === "/api/portability/export"
		)
			requests.push(request.url());
	});
	page.on("download", (download) => {
		downloads.push(download);
	});
	return { requests, downloads };
}

async function downloadedExport(download: Download): Promise<PortableExportV2> {
	expect(download.suggestedFilename()).toBe("ditero-history-v2.json");
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	const exported: PortableExportV2 = JSON.parse(
		Buffer.concat(chunks).toString("utf8"),
	);
	expect(exported.format).toBe("ditero");
	expect(exported.schemaVersion).toBe(2);
	expect(exported.boundaries.attachmentContent).toBe("excluded");
	expect(exported.boundaries.restoreSupported).toBe(false);
	return exported;
}

async function dirtyMarkers(page: Page) {
	return page.evaluate(() =>
		Object.keys(localStorage)
			.filter((key) => key.startsWith("ditero:export:v1:"))
			.sort()
			.map((key) => [key, localStorage.getItem(key)]),
	);
}

const pendingMessage = /Some edits are still pending/;
const fallbackName = "Download server-saved snapshot anyway";

test("waits for a held real mutation before downloading its saved task", async ({
	page,
}) => {
	test.setTimeout(60000);
	const pushes = await installPushHold(page);
	await savedList(page, "Maya's appointments");
	const events = exportEvents(page);
	pushes.hold();
	const title = "Maya: book Leo's dentist appointment";
	await optimisticTask(page, title);
	await expect.poll(() => pushes.count).toBeGreaterThan(0);
	await goToSettings(page);
	const panel = page.getByRole("region", { name: "Export your data" });
	await panel.getByRole("button", { name: "Download JSON" }).click();
	await expect(
		panel.getByRole("button", { name: "Waiting for edits to be saved" }),
	).toBeDisabled();
	expect(events.requests).toHaveLength(0);
	expect(events.downloads).toHaveLength(0);
	const status = panel.getByRole("status");
	await expect(status).toHaveAttribute("aria-live", "polite");
	await expect(status).toHaveText("Waiting for edits to be saved");
	await panel.screenshot({
		path: test.info().outputPath("export-waiting-desktop.png"),
	});
	let releaseResponse = () => {};
	const heldResponse = new Promise<void>((resolve) => {
		releaseResponse = resolve;
	});
	await page.route(
		"**/api/portability/export?version=2",
		async (route) => {
			const response = await route.fetch();
			expect(response.ok()).toBe(true);
			await heldResponse;
			await route.fulfill({ response });
		},
		{ times: 1 },
	);
	const file = page.waitForEvent("download");
	pushes.release();
	try {
		await expect(status).toHaveText("Preparing export…");
		await expect(
			panel.getByRole("button", { name: "Preparing export…" }),
		).toBeDisabled();
		await panel.screenshot({
			path: test.info().outputPath("export-preparing-desktop.png"),
		});
	} finally {
		releaseResponse();
	}
	const exported = await downloadedExport(await file);
	await expect(status).toHaveText(
		"Download requested. Check your browser downloads.",
	);
	await panel.screenshot({
		path: test.info().outputPath("export-requested-desktop.png"),
	});
	expect(exported.data.tasks.some((task) => task.title === title)).toBe(true);
	expect(events.requests).toHaveLength(1);
	expect(events.downloads).toHaveLength(1);
});

test.describe(() => {
	test.use({ hasTouch: true });
	test("times out without a file and offers an explicit saved-only snapshot", async ({
		page,
	}) => {
		test.setTimeout(60000);
		const pushes = await installPushHold(page);
		await savedList(page, "Alex's household chores");
		const events = exportEvents(page);
		pushes.hold();
		const title = "Alex: replace the kitchen smoke alarm battery";
		await optimisticTask(page, title);
		await expect.poll(() => pushes.count).toBeGreaterThan(0);
		await goToSettings(page);
		const panel = page.getByRole("region", { name: "Export your data" });
		const started = performance.now();
		await panel.getByRole("button", { name: "Download JSON" }).click();
		await expect(panel.getByRole("alert")).toHaveText(pendingMessage, {
			timeout: 15000,
		});
		expect(performance.now() - started).toBeGreaterThanOrEqual(9000);
		expect(events.requests).toHaveLength(0);
		expect(events.downloads).toHaveLength(0);
		const before = await dirtyMarkers(page);
		expect(before.length).toBeGreaterThan(0);
		await page.setViewportSize({ width: 320, height: 844 });
		const fallback = panel.getByRole("button", { name: fallbackName });
		expect(
			await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
		).toBe(true);
		for (const control of [
			fallback,
			panel.getByRole("button", { name: "Download JSON", exact: true }),
		]) {
			const bounds = await control.boundingBox();
			expect(bounds).not.toBeNull();
			expect(bounds?.height).toBeGreaterThanOrEqual(44);
			expect(bounds?.x).toBeGreaterThanOrEqual(0);
			expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(320);
			expect(
				await control.evaluate(
					(element) => element.scrollWidth <= element.clientWidth,
				),
			).toBe(true);
			expect(
				await control.evaluate(
					(element) => getComputedStyle(element).whiteSpace,
				),
			).toBe("normal");
		}
		await panel.screenshot({
			path: test.info().outputPath("export-fallback-mobile.png"),
		});
		const savedOnly = page.waitForEvent("download");
		await fallback.focus();
		await expect(fallback).toBeFocused();
		await fallback.press("Enter");
		const excluded = await downloadedExport(await savedOnly);
		await expect(fallback).toHaveCount(0);
		await expect(
			panel.getByRole("button", { name: "Download JSON", exact: true }),
		).toBeFocused();
		await expect(panel.getByRole("status")).toHaveText(
			"Download requested. Check your browser downloads.",
		);
		await panel.screenshot({
			path: test.info().outputPath("export-requested-mobile.png"),
		});
		expect(excluded.data.tasks.some((task) => task.title === title)).toBe(
			false,
		);
		expect(await dirtyMarkers(page)).toEqual(before);
		const complete = page.waitForEvent("download");
		pushes.release();
		await panel.getByRole("button", { name: "Download JSON" }).click();
		const included = await downloadedExport(await complete);
		expect(included.data.tasks.some((task) => task.title === title)).toBe(true);
		expect(events.requests).toHaveLength(2);
		expect(events.downloads).toHaveLength(2);
	});
});

test("refuses offline edits and keeps their pending marker unknown after reload", async ({
	page,
	context,
}) => {
	test.setTimeout(60000);
	const pushes = await installPushHold(page);
	await savedList(page, "Sam's errands");
	const events = exportEvents(page);
	pushes.hold();
	const title = "Sam: collect Maya's prescription";
	await optimisticTask(page, title);
	await expect.poll(() => pushes.count).toBeGreaterThan(0);
	await context.setOffline(true);
	const offlineTitle = "Sam: return Leo's library books";
	await optimisticTask(page, offlineTitle);
	await goToSettings(page);
	let panel = page.getByRole("region", { name: "Export your data" });
	await panel.getByRole("button", { name: "Download JSON" }).click();
	await expect(panel.getByRole("alert")).toHaveText(pendingMessage);
	expect(events.requests).toHaveLength(0);
	expect(events.downloads).toHaveLength(0);
	const before = await dirtyMarkers(page);
	expect(before.length).toBeGreaterThan(0);
	await context.setOffline(false);
	await page.reload();
	await waitWorkspaceReady(page);
	await goToSettings(page);
	panel = page.getByRole("region", { name: "Export your data" });
	await panel.getByRole("button", { name: "Download JSON" }).click();
	await expect(panel.getByRole("alert")).toHaveText(pendingMessage);
	expect(events.requests).toHaveLength(0);
	expect(events.downloads).toHaveLength(0);
	const savedOnly = page.waitForEvent("download");
	await panel.getByRole("button", { name: fallbackName }).click();
	const exported = await downloadedExport(await savedOnly);
	expect(exported.data.tasks.some((task) => task.title === title)).toBe(false);
	expect(exported.data.tasks.some((task) => task.title === offlineTitle)).toBe(
		false,
	);
	const after = await dirtyMarkers(page);
	for (const marker of before) expect(after).toContainEqual(marker);
	expect(events.requests).toHaveLength(1);
	expect(events.downloads).toHaveLength(1);
});
