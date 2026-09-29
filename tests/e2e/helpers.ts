import { expect, type Locator, type Page } from "@playwright/test";

const surface = (page: Page) => page.getByTestId("settings-surface");

// Settings is a destination on both platforms (desktop sidebar footer; on
// phones, the workspace switcher atop the Lists tab), never inlined into the
// landing. One seam so a shell change costs one edit instead of thirty.
// Attribute selectors, not roles: role locators skip aria-hidden nodes whenever
// a Radix modal surface is open. Idempotent, so a caller that reached settings
// its own way can still route through it.
export async function goToSettings(page: Page): Promise<void> {
	if (!(await surface(page).count())) {
		// By viewport, not by probing: right after a reload the shell may not be
		// mounted yet, and an instant visibility check would pick the wrong path.
		if ((page.viewportSize()?.width ?? 1280) >= 768)
			await page.getByTestId("nav-settings").click();
		else {
			await openMobileLists(page);
			await openWorkspaceSwitcher(page);
			await page.getByTestId("switcher-settings").click();
		}
	}
	await expect(surface(page)).toBeVisible();
}

// Phones: the list index, create-list form, views and dashboards live on the
// Lists tab; Today is the landing.
export async function openMobileLists(page: Page): Promise<void> {
	await page.getByTestId("nav-tab-lists").click();
	await expect(page.getByTestId("nav-tab-lists")).toHaveAttribute(
		"aria-current",
		"page",
	);
	// Attached, not visible: with no lists yet the index has no height.
	await expect(page.getByTestId("list-index")).toHaveCount(1);
}

export async function openWorkspaceSwitcher(page: Page): Promise<void> {
	// A menu still animating closed would swallow the click and toggle back.
	await expect(page.getByTestId("switcher-settings")).toHaveCount(0);
	await page.getByTestId("workspace-switcher").click();
	await expect(page.getByTestId("switcher-settings")).toBeVisible();
}

// Members management sits inside the switcher, and only for a shared workspace.
export async function openMembers(page: Page): Promise<void> {
	await openWorkspaceSwitcher(page);
	await page.getByTestId("manage-members").click();
	await expect(page.getByTestId("members-panel")).toBeVisible();
}

export function workspaceOption(page: Page, name: string): Locator {
	return page
		.getByTestId("workspace-option")
		.filter({ has: page.getByText(name, { exact: true }) });
}

// Waits for the workspace to sync: its option only renders once the row has
// arrived, and an open menu re-renders when it does.
export async function switchWorkspace(page: Page, name: string): Promise<void> {
	await openWorkspaceSwitcher(page);
	await workspaceOption(page, name).click();
	await expect(page.getByTestId("switcher-settings")).toHaveCount(0);
	await expect(page.getByTestId("workspace-switcher")).toContainText(name);
}

// Desktop: switch to the seeded shared workspace and open its seeded list. By
// name, not position: other specs add lists to the same workspace, and sidebar
// order would open whichever of theirs sorts first. Waits for the membership to
// sync: the option only renders once the workspace row has arrived.
export async function openShared(page: Page): Promise<void> {
	await openWorkspaceSwitcher(page);
	await page
		.locator('[data-testid="workspace-option"][data-workspace-kind="shared"]')
		.first()
		.click();
	await expect(page.getByTestId("switcher-settings")).toHaveCount(0);
	await expect(page.getByTestId("workspace-switcher")).not.toContainText(
		"'s space",
	);
	await page
		.locator('nav[aria-label="Lists"] [data-list-id]')
		.filter({ hasText: /^Shared list$/ })
		.click();
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

// The workspace switcher names the active workspace only once the workspace
// query has synced, so its id is the seam between "shell mounted" and "data
// usable". Any active workspace counts, personal or shared.
export async function waitWorkspaceReady(page: Page): Promise<void> {
	await expect(page.getByTestId("workspace-switcher")).toHaveAttribute(
		"data-workspace-id",
		/.+/,
		{ timeout: SIGNUP_TIMEOUT },
	);
}

// A task row's title lives on its checkbox; the open control is named "Open
// details", so the row is found through the checkbox that names it. Covers top
// rows and expanded subtasks alike.
export async function openDetails(page: Page, title: string): Promise<void> {
	await page
		.getByTestId("list")
		.locator("[data-kbd-row], li")
		.filter({ has: page.getByRole("checkbox", { name: title, exact: true }) })
		.last()
		.getByRole("button", { name: "Open details" })
		.first()
		.click();
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
