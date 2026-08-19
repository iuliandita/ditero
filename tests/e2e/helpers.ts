import { expect, type Page } from "@playwright/test";

// Settings is a destination on both platforms (desktop sidebar, mobile bottom
// tab), never inlined into the landing. One seam so a shell change costs one
// edit instead of thirty. Attribute selectors, not roles: a tab's only text is
// its translated label, and role locators skip aria-hidden nodes whenever a
// Radix modal surface is open.
export async function goToSettings(page: Page): Promise<void> {
	await page
		.locator('[data-testid="nav-settings"], [data-testid="nav-tab-settings"]')
		.first()
		.click();
	await expect(page.getByTestId("settings-surface")).toBeVisible();
}

// Leaves settings for the lists landing. The in-surface control exists on both
// platforms, so it needs no per-viewport branch.
export async function leaveSettings(page: Page): Promise<void> {
	await page.getByTestId("settings-back").click();
	await expect(page.getByTestId("settings-surface")).toHaveCount(0);
}
