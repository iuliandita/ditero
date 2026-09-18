import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
	goToSettings,
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
	expect(download.suggestedFilename()).toBe("ditero-export-v1.json");
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	const exported = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	expect(exported.format).toBe("ditero");
	expect(exported.schemaVersion).toBe(1);
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
	await page.route("**/api/portability/export", (route) =>
		route.fulfill({ status: 413 }),
	);
	const button = page.getByRole("button", { name: "Download JSON" });
	await button.click();
	await expect(page.getByRole("alert")).toHaveText(
		"This export exceeds the download limit. No partial file was created.",
	);
	await expect(button).toBeEnabled();
	await page.unroute("**/api/portability/export");
	const download = page.waitForEvent("download");
	await button.click();
	await download;
	await expect(page.getByRole("alert")).toHaveCount(0);
});
