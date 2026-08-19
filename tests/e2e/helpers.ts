import { expect, type Page } from "@playwright/test";

const surface = (page: Page) => page.getByTestId("settings-surface");

// Settings is a destination on both platforms (desktop sidebar, mobile bottom
// tab), never inlined into the landing. One seam so a shell change costs one
// edit instead of thirty. Attribute selectors, not roles: a tab's only text is
// its translated label, and role locators skip aria-hidden nodes whenever a
// Radix modal surface is open. Idempotent, so a caller that reached settings
// its own way (the mobile tab) can still route through it.
export async function goToSettings(page: Page): Promise<void> {
	if (!(await surface(page).count())) {
		await page
			.locator('[data-testid="nav-settings"], [data-testid="nav-tab-settings"]')
			.first()
			.click();
	}
	await expect(surface(page)).toBeVisible();
}

// Leaves settings for the lists landing, where the create-list form lives. The
// in-surface control exists on both platforms, so it needs no viewport branch.
// Idempotent for the same reason as above.
export async function leaveSettings(page: Page): Promise<void> {
	if (await surface(page).count()) {
		await page.getByTestId("settings-back").click();
	}
	await expect(surface(page)).toHaveCount(0);
}
