import { expect, type Locator, type Page } from "@playwright/test";

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

const PASSWORD = "pw-123456";
const SIGNUP_TIMEOUT = 30_000;

let emailSeq = 0;

// Unique per call AND per run: the e2e database is seeded once and reused, so a
// fixed address collides with a previous run's user.
export function uniqueEmail(prefix: string): string {
	emailSeq += 1;
	return `${prefix}-${Date.now()}-${emailSeq}@t.dev`;
}

// Signup (email verification is off) yields an active session directly. No
// get-session round trip: only sign-in/up carry the relaxed E2E rate limit.
export async function signUp(page: Page, email: string): Promise<void> {
	await page.goto("/");
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill(PASSWORD);
	await page.getByTestId("signup").click();
	await expect(page.getByTestId("workspace")).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
}

// The workspace switcher button only renders once the workspace query has
// synced, so it is the seam between "shell mounted" and "data usable".
export async function waitWorkspaceReady(page: Page): Promise<void> {
	await expect(page.getByRole("button", { name: /'s space/ })).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
}

// Desktop sidebar list/view nav: scopes clicks away from the mobile index and
// the create-list controls that share their labels with list titles.
export function sidebarLists(page: Page): Locator {
	return page.getByRole("navigation", { name: "Lists" });
}

// The task detail's due date is a popover with a typed field; the typed field
// accepts an ISO day key, which keeps callers locale-independent. The popover
// is portaled, so it is found on the page, not inside the detail.
export async function setDueDate(
	page: Page,
	detail: Locator,
	date: string,
): Promise<void> {
	await detail.getByTestId("due-picker").click();
	const input = page.getByTestId("due-picker-input");
	await input.fill(date);
	await input.press("Enter");
	await expect(page.getByTestId("due-picker-content")).toHaveCount(0);
}

// Repeat, reminder, focus, files and move live behind "More options". Its open
// state is remembered per session, so this only clicks when it is closed.
export async function openMoreOptions(detail: Locator): Promise<void> {
	const toggle = detail.getByTestId("task-more-toggle");
	if ((await toggle.getAttribute("aria-expanded")) !== "true")
		await toggle.click();
	await expect(detail.getByTestId("task-more")).toBeVisible();
}

// Picks an option from a ui Select (Radix). The listbox is portaled, so the
// option is found on the page, and waiting for it to close keeps the next
// action from landing on the dismiss guard.
export async function chooseOption(
	page: Page,
	trigger: Locator,
	name: string,
): Promise<void> {
	await trigger.click();
	await page.getByRole("option", { name, exact: true }).click();
	await expect(page.getByRole("listbox")).toHaveCount(0);
}
