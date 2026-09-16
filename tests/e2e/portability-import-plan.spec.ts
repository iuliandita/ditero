import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
	goToSettings,
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

test("saves and deduplicates a dry run without changing tasks, then discards it", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("import-plan"));
	await waitWorkspaceReady(page);
	await page.getByTestId("new-list").fill("Import dry-run check");
	await page.getByTestId("new-list-submit").click();
	await sidebarLists(page)
		.getByRole("button", { name: "Import dry-run check", exact: true })
		.last()
		.click();
	await page.getByTestId("new-task").fill("Keep this task unchanged");
	await page.getByTestId("new-task-submit").click();
	await expect(
		page
			.getByTestId("list")
			.getByText("Keep this task unchanged", { exact: true }),
	).toBeVisible();
	await goToSettings(page);
	const downloadEvent = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download JSON" }).click();
	const download = await downloadEvent;
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	const document = Buffer.concat(chunks);
	const exported = JSON.parse(document.toString("utf8"));
	expect(exported.data.tasks).toHaveLength(1);
	const panel = page.getByRole("region", { name: "Plan an import" });
	await panel.getByLabel("Native JSON export").setInputFiles({
		name: "export.json",
		mimeType: "application/json",
		buffer: document,
	});
	await panel.getByLabel("Source label").fill("Original account");
	await expect(panel.getByTestId("import-workspace")).toHaveCount(
		exported.data.workspaces.length,
	);
	for (const select of await panel.getByTestId("import-workspace").all())
		await select.selectOption(exported.data.workspaces[0].id);
	// Lose the response after persistence, then retry the same source identity.
	let firstId = "";
	await page.route(
		"**/api/portability/import/plans",
		async (route) => {
			const response = await route.fetch();
			expect(response.ok()).toBeTruthy();
			firstId = (await response.json()).id;
			await route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({ code: "unavailable" }),
			});
		},
		{ times: 1 },
	);
	await panel.getByRole("button", { name: "Save dry run" }).click();
	await expect(panel.getByRole("alert")).toContainText("The request failed");
	const retry = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/portability/import/plans") &&
			response.status() === 200,
	);
	await panel.getByRole("button", { name: "Save dry run" }).click();
	expect((await (await retry).json()).id).toBe(firstId);
	await expect(panel.getByRole("status")).toContainText("Nothing is imported");
	await expect(
		panel.getByRole("button", { name: "Discard dry run", exact: true }),
	).toHaveCount(1);
	const screenshotPath = test.info().outputPath("import-dry-run-settings.png");
	await panel.screenshot({ path: screenshotPath });
	await test.info().attach("import-dry-run-settings", {
		path: screenshotPath,
		contentType: "image/png",
	});
	expect(
		(await new AxeBuilder({ page }).include("#import-plan").analyze())
			.violations,
	).toEqual([]);
	const after = await page.request.get("/api/portability/export");
	expect((await after.json()).data.tasks).toEqual(exported.data.tasks);
	await panel
		.getByRole("button", { name: "Discard dry run", exact: true })
		.click();
	await page.getByTestId("confirm-accept").click();
	await expect(
		panel.getByRole("button", { name: "Discard dry run", exact: true }),
	).toHaveCount(0);
	await panel
		.getByRole("button", { name: "Discard source", exact: true })
		.click();
	await page.getByTestId("confirm-accept").click();
	await expect(
		panel.getByRole("button", { name: "Discard source", exact: true }),
	).toHaveCount(0);
});

test("rejects malformed files locally without saving a plan", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("import-invalid"));
	await waitWorkspaceReady(page);
	await goToSettings(page);
	const panel = page.getByRole("region", { name: "Plan an import" });
	await panel.getByLabel("Native JSON export").setInputFiles({
		name: "invalid.json",
		mimeType: "application/json",
		buffer: Buffer.from('{"format":"ditero"}'),
	});
	await expect(panel.getByRole("alert")).toContainText(
		"not a valid native export",
	);
	await expect(
		panel.getByRole("button", { name: "Save dry run" }),
	).toBeDisabled();
});
