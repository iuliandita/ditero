import { expect, test } from "@playwright/test";
import {
	openMembers,
	openMobileLists,
	openWorkspaceSwitcher,
	signUp,
	uniqueEmail,
} from "./helpers.ts";

test("a new account creates a shared workspace through the switcher and retains personal scope", async ({
	page,
	browser,
}, testInfo) => {
	await signUp(page, uniqueEmail("workspace-create"));
	if ((page.viewportSize()?.width ?? 1280) < 768) await openMobileLists(page);
	const personal = await page
		.getByTestId("workspace-switcher")
		.getAttribute("data-workspace-id");
	expect(personal).toBeTruthy();
	await openWorkspaceSwitcher(page);
	await expect(
		page.locator(
			'[data-testid="workspace-option"][data-workspace-kind="shared"]',
		),
	).toHaveCount(0);
	await page.getByTestId("create-workspace").click();
	await expect(page.getByTestId("switcher-settings")).toHaveCount(0);
	const dialog = page.getByTestId("create-workspace-dialog");
	await expect(dialog).toHaveCount(1);
	await expect(page.getByTestId("create-workspace-name")).toHaveCount(1);
	await expect(page.getByTestId("create-workspace-submit")).toHaveCount(1);
	await expect(dialog).toBeVisible();

	await expect(page.getByTestId("create-workspace-name")).toBeFocused();
	if ((page.viewportSize()?.width ?? 1280) < 768) {
		const geometry = {
			dialog: await dialog.boundingBox(),
			form: await dialog.locator("form").boundingBox(),
			name: await page.getByTestId("create-workspace-name").boundingBox(),
			submit: await page.getByTestId("create-workspace-submit").boundingBox(),
			viewport: page.viewportSize(),
			document: await page.evaluate(() => ({
				width: document.documentElement.scrollWidth,
				viewport: window.innerWidth,
			})),
		};
		await testInfo.attach("mobile-creation-geometry", {
			body: JSON.stringify(geometry),
			contentType: "application/json",
		});
		for (const box of [
			geometry.dialog,
			geometry.form,
			geometry.name,
			geometry.submit,
		]) {
			if (!box || !geometry.viewport)
				throw new Error("Missing mobile geometry");
			expect(box.x).toBeGreaterThanOrEqual(0);
			expect(box.x + box.width).toBeLessThanOrEqual(geometry.viewport.width);
		}
		expect(geometry.name?.height).toBeGreaterThanOrEqual(44);
		expect(geometry.submit?.height).toBeGreaterThanOrEqual(44);
		expect(geometry.document.width).toBeLessThanOrEqual(
			geometry.document.viewport,
		);
	}
	const name = `Group ${Date.now()} 家族`;
	await page.getByTestId("create-workspace-name").fill(`  ${name}  `);
	await page.getByTestId("create-workspace-submit").click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByTestId("workspace-switcher")).toContainText(name);
	const shared = await page
		.getByTestId("workspace-switcher")
		.getAttribute("data-workspace-id");
	expect(shared).toBeTruthy();
	expect(shared).not.toBe(personal);
	await openMembers(page);
	await expect(page.getByTestId("members-panel")).toBeVisible();
	await expect(page.getByTestId("invite-open")).toBeVisible();
	const inviteeEmail = uniqueEmail("workspace-create-invitee");
	await page.getByTestId("invite-open").click();
	await page.getByTestId("invite-email").fill(inviteeEmail);
	await page.getByTestId("invite-submit").click();
	await expect(page.getByTestId("invite-link")).toBeVisible();
	const link = await page.getByTestId("invite-link").inputValue();
	const token = new URL(link).searchParams.get("token");
	expect(token).toBeTruthy();
	const context = await browser.newContext();
	try {
		const invited = await context.newPage();
		await invited.goto(
			new URL(`/accept?token=${encodeURIComponent(token ?? "")}`, page.url())
				.href,
		);
		await expect(invited.getByTestId("accept-page")).toBeVisible();
		await invited.getByTestId("accept-email").fill(inviteeEmail);
		await invited.getByTestId("accept-password").fill("pw-123456");
		await invited.getByTestId("accept-submit").click();
		await expect(invited.getByTestId("workspace")).toBeVisible();
		if ((invited.viewportSize()?.width ?? 1280) < 768)
			await openMobileLists(invited);
		await openWorkspaceSwitcher(invited);
		await expect(
			invited.locator(
				'[data-testid="workspace-option"][data-workspace-kind="shared"]',
			),
		).toContainText(name);
		await expect(
			invited.locator(
				'[data-testid="workspace-option"][data-workspace-kind="personal"]',
			),
		).toHaveCount(1);
	} finally {
		await context.close();
	}
	await page
		.getByTestId("invite-dialog")
		.getByRole("button", { name: "Close", exact: true })
		.click();
	await expect(page.getByTestId("invite-dialog")).toHaveCount(0);

	await page
		.getByTestId("members-panel")
		.getByRole("button", { name: "Close", exact: true })
		.click();
	await expect(page.getByTestId("members-panel")).toHaveCount(0);
	await page.reload();
	if ((page.viewportSize()?.width ?? 1280) < 768) await openMobileLists(page);
	await openWorkspaceSwitcher(page);
	await expect(
		page.locator(
			'[data-testid="workspace-option"][data-workspace-kind="shared"]',
		),
	).toContainText(name);
	await expect(
		page.locator(
			'[data-testid="workspace-option"][data-workspace-kind="personal"]',
		),
	).toHaveCount(1);
	await page
		.locator('[data-testid="workspace-option"][data-workspace-kind="personal"]')
		.click();
	await expect(page.getByTestId("workspace-switcher")).toHaveAttribute(
		"data-workspace-id",
		personal ?? "",
	);
});
