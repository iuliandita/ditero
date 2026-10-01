import { expect, type Page, test } from "@playwright/test";
import {
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

// Contextual help (#361): the quick-add grammar legend, the `?` shortcut hint,
// and a first run that lands inside the list it just created.

async function blur(page: Page) {
	await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

async function reopenList(page: Page, name: string) {
	await page.reload();
	await sidebarLists(page)
		.getByRole("button", { name, exact: true })
		.click({ timeout: 15000 });
	await expect(page.getByTestId("new-task")).toBeVisible();
}

async function firstBlankList(page: Page, name: string, kind?: string) {
	await expect(page.getByTestId("view-empty-first-use")).toBeVisible({
		timeout: 15000,
	});
	await page.getByTestId("first-run-create-list").click();
	await page.getByTestId("new-list").fill(name);
	if (kind) await page.getByRole("button", { name: kind, exact: true }).click();
	await page.getByTestId("new-list").press("Enter");
	// Not a role query: on a phone quick add opens over the list at once, and a
	// Radix modal aria-hides everything behind it.
	await expect(page.locator('[data-testid="list"] h1')).toHaveText(name, {
		timeout: 15000,
	});
}

test("first run lands in the blank list, focused, with the grammar and one example", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("hint1"));
	await waitWorkspaceReady(page);
	await firstBlankList(page, "Errands");

	await expect(page.getByTestId("new-task")).toBeFocused();
	const hint = page.getByTestId("list").getByTestId("syntax-hint");
	await expect(hint).toBeVisible();
	await expect(hint).toContainText("This field saves your text as written.");
	await expect(hint.getByTestId("syntax-hint-example")).not.toBeVisible();
	await hint.getByTestId("syntax-hint-details").click();
	await expect(hint.getByTestId("syntax-hint-example")).toHaveText(
		"Example: Call the plumber tomorrow p1 #home",
	);
	await expect(hint.locator("kbd")).toHaveText("c");
	await expect(page.getByTestId("new-task-submit")).toHaveText("Add task");
	await expect(page.getByTestId("list-empty-add")).toHaveText("Add task");
});

// Field, button and empty state name a new row the same way per kind (#367).
test("a blank checklist speaks of items everywhere it offers an add", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("hint8"));
	await waitWorkspaceReady(page);
	await firstBlankList(page, "Packing", "Checklist");
	await expect(page.getByTestId("new-task")).toBeFocused();
	await expect(page.getByTestId("new-task")).toHaveAttribute(
		"placeholder",
		"Add an item",
	);
	await expect(page.getByTestId("new-task-submit")).toHaveText("Add item");
	await expect(page.getByTestId("list-empty-add")).toHaveText("Add item");
});

test("a starter lands focused without the example line", async ({ page }) => {
	await signUp(page, uniqueEmail("hint2"));
	await waitWorkspaceReady(page);
	await page.getByTestId("first-run-starter-shopping").click();
	await expect(
		page.getByTestId("list").getByText("Milk", { exact: true }),
	).toBeVisible({ timeout: 15000 });
	await expect(page.getByTestId("new-task")).toBeFocused();
	await expect(page.getByTestId("syntax-hint")).toBeVisible();
	await expect(page.getByTestId("syntax-hint-example")).toHaveCount(0);
});

test("the syntax hint retires after three quick adds that used a token", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("hint3"));
	await waitWorkspaceReady(page);
	await firstBlankList(page, "Chores");

	await page.getByTestId("syntax-hint-open-quickadd").click();
	const input = page.getByTestId("quickadd-input");
	await expect(input).toBeFocused();
	const sheetHint = page.locator('[role="dialog"] [data-testid="syntax-hint"]');
	await expect(sheetHint).toBeVisible();

	// Plain titles teach nothing and do not count.
	await input.fill("Water plants");
	await input.press("Enter");
	for (const title of ["Walk dog tomorrow", "Pay rent p1"]) {
		await input.fill(title);
		await input.press("Enter");
		await expect(input).toHaveValue("");
	}
	await expect(sheetHint).toBeVisible();

	await input.fill("Buy bread #shop");
	await input.press("Enter");
	await expect(input).toHaveValue("");
	await expect(input).toBeVisible();
	await expect(sheetHint).toHaveCount(0);

	await page.keyboard.press("Escape");
	await expect(page.getByTestId("new-task")).toBeVisible();
	await expect(page.getByTestId("syntax-hint")).toHaveCount(0);
	await reopenList(page, "Chores");
	await expect(page.getByTestId("syntax-hint")).toHaveCount(0);
});

test("dismissing the syntax hint retires it everywhere", async ({ page }) => {
	await signUp(page, uniqueEmail("hint4"));
	await waitWorkspaceReady(page);
	await firstBlankList(page, "Garden");

	await page.getByTestId("syntax-hint-dismiss").click();
	await expect(page.getByTestId("new-task")).toBeVisible();
	await expect(page.getByTestId("syntax-hint")).toHaveCount(0);
	await page.getByRole("button", { name: "Quick add", exact: true }).click();
	await expect(page.getByTestId("quickadd-input")).toBeVisible();
	await page.keyboard.press("Escape");

	await blur(page);
	await page.keyboard.press("c");
	await expect(page.getByTestId("quickadd-input")).toBeVisible();
	await expect(page.locator('[data-testid="syntax-hint"]')).toHaveCount(0);
	await page.keyboard.press("Escape");

	await reopenList(page, "Garden");
	await expect(page.getByTestId("syntax-hint")).toHaveCount(0);
});

test("the shortcut hint shows until the cheat sheet has been opened", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("hint5"));
	await waitWorkspaceReady(page);
	const hint = page.getByTestId("shortcut-hint");
	await expect(hint).toHaveText("Press ? for keyboard shortcuts");

	await blur(page);
	await page.keyboard.press("?");
	await expect(
		page.getByRole("heading", { name: "Keyboard shortcuts" }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("nav-settings")).toBeVisible();
	await expect(hint).toHaveCount(0);

	await page.reload();
	await expect(page.getByTestId("nav-settings")).toBeVisible({
		timeout: 15000,
	});
	await expect(hint).toHaveCount(0);
});

test("a touch-only tablet gets no shortcut hint", async ({ browser }) => {
	const ctx = await browser.newContext({
		viewport: { width: 1024, height: 768 },
		hasTouch: true,
		isMobile: true,
	});
	const page = await ctx.newPage();
	await signUp(page, uniqueEmail("hint6"));
	await waitWorkspaceReady(page);
	await expect(page.getByTestId("nav-settings")).toBeVisible();
	await expect(page.getByTestId("shortcut-hint")).toHaveCount(0);
	await ctx.close();
});

test("on a phone a blank first list focuses the inline field with the grammar", async ({
	browser,
}) => {
	const ctx = await browser.newContext({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});
	const page = await ctx.newPage();
	await signUp(page, uniqueEmail("hint7"));
	await waitWorkspaceReady(page);
	await firstBlankList(page, "Kitchen");
	await expect(page.getByTestId("new-task")).toBeFocused();
	const hint = page.getByTestId("list").getByTestId("syntax-hint");
	await expect(hint).toBeVisible();
	await expect(hint.getByTestId("syntax-hint-example")).not.toBeVisible();
	await hint.getByTestId("syntax-hint-details").click();
	await expect(hint.getByTestId("syntax-hint-example")).toBeVisible();
	// No keycap on touch: the lead just opens quick add.
	await expect(hint.locator("kbd")).toHaveCount(0);
	await hint.getByTestId("syntax-hint-open-quickadd").click();
	await expect(page.getByTestId("quickadd-input")).toBeFocused();
	await ctx.close();
});
