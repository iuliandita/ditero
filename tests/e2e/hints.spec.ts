import { expect, type Page, test } from "@playwright/test";
import { signUp, uniqueEmail, waitWorkspaceReady } from "./helpers.ts";

// Contextual help (#361): the quick-add grammar legend, the `?` shortcut hint,
// and a first run that lands inside the list it just created. The list's own
// add field reads that grammar itself, so it carries no help text (#1244).

async function blur(page: Page) {
	await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
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

test("first run lands in the blank list, focused, with no help block under the field", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("hint1"));
	await waitWorkspaceReady(page);
	await firstBlankList(page, "Errands");

	await expect(page.getByTestId("new-task")).toBeFocused();
	await expect(page.getByTestId("syntax-hint")).toHaveCount(0);
	await expect(
		page.getByText("This field saves your text as written."),
	).toHaveCount(0);
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

test("a starter lands focused with no help block", async ({ page }) => {
	await signUp(page, uniqueEmail("hint2"));
	await waitWorkspaceReady(page);
	await page.getByTestId("first-run-starter-shopping").click();
	await expect(
		page.getByTestId("list").getByText("Milk", { exact: true }),
	).toBeVisible({ timeout: 15000 });
	await expect(page.getByTestId("new-task")).toBeFocused();
	await expect(page.getByTestId("syntax-hint")).toHaveCount(0);
});

test("quick add opens from c and keeps its syntax legend", async ({ page }) => {
	await signUp(page, uniqueEmail("hint3"));
	await waitWorkspaceReady(page);
	await firstBlankList(page, "Garden");

	await blur(page);
	await page.keyboard.press("c");
	await expect(page.getByTestId("quickadd-input")).toBeFocused();
	const legend = page.locator('[role="dialog"] [data-testid="syntax-hint"]');
	await expect(legend).toBeVisible();
	await legend.getByTestId("syntax-hint-details").click();
	await expect(legend).toContainText("Priority, p1 is highest");
});

test("the list field reads quick-add syntax into chips and saves them", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("hint4"));
	await waitWorkspaceReady(page);
	await firstBlankList(page, "Home");

	const input = page.getByTestId("new-task");
	const chips = page.getByTestId("list-composer-chips");
	await input.fill("Call plumber Jan 15 2030 p1 #home");
	await expect(chips.getByTestId("chip-date")).toBeVisible();
	await expect(chips.getByTestId("chip-priority")).toBeVisible();
	await expect(chips.getByTestId("chip-label")).toBeVisible();
	await input.press("Enter");
	await expect(input).toHaveValue("");
	await expect(chips).toHaveCount(0);

	// Fixed expectations, not the parser's output: an all-day Jan 15, P1, home.
	const saved = () =>
		page
			.getByTestId("list")
			.locator("[data-kbd-row]")
			.filter({
				has: page.getByRole("checkbox", { name: "Call plumber", exact: true }),
			});
	const expectSaved = async () => {
		const row = saved();
		await expect(row).toBeVisible({ timeout: 15000 });
		await expect(row.getByText("Jan 15", { exact: true })).toBeVisible();
		const flag = row.getByRole("img", { name: "Priority: P1 High" });
		await expect(flag).toHaveAttribute("data-priority", "3");
		await expect(row.getByText("home", { exact: true })).toBeVisible();
	};
	await expectSaved();
	await expect(
		page.getByTestId("list").getByText("Call plumber Jan 15"),
	).toHaveCount(0);
	await page.reload();
	await expectSaved();
});

test("one Backspace after a chip turns it back into plain words", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("hint9"));
	await waitWorkspaceReady(page);
	await firstBlankList(page, "Bills");

	const input = page.getByTestId("new-task");
	await input.fill("Pay rent p1");
	await expect(page.getByTestId("chip-priority")).toBeVisible();
	await input.press("Backspace");
	await expect(page.getByTestId("chip-priority")).toHaveCount(0);
	await expect(input).toHaveValue("Pay rent p1");
	await input.press("Enter");
	await expect(
		page.getByTestId("list").getByText("Pay rent p1", { exact: true }),
	).toBeVisible({ timeout: 15000 });

	// The chip's own button does the same.
	await input.fill("Pay water #home");
	await page.getByRole("button", { name: "Keep #home as text" }).click();
	await expect(page.getByTestId("chip-label")).toHaveCount(0);
	await expect(input).toHaveValue("Pay water #home");
});

test("on a phone the draft and a kept chip survive the list regrouping", async ({
	browser,
}) => {
	const ctx = await browser.newContext({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});
	const page = await ctx.newPage();
	await signUp(page, uniqueEmail("hint11"));
	await waitWorkspaceReady(page);
	await firstBlankList(page, "Rent");

	const input = page.getByTestId("new-task");
	await input.fill("Seed");
	await input.press("Enter");
	await expect(
		page.getByTestId("list").getByText("Seed", { exact: true }),
	).toBeVisible({ timeout: 15000 });

	await input.fill("Pay rent p1");
	await input.press("Backspace");
	await expect(page.getByTestId("chip-priority")).toHaveCount(0);

	// Grouping moves the phone add field to another subtree.
	await page.getByTestId("row-actions").first().tap();
	await page.getByTestId("group-by-assignee").tap();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("new-task")).toHaveValue("Pay rent p1");
	await expect(page.getByTestId("chip-priority")).toHaveCount(0);
	await ctx.close();
});

test("a ~list that does not exist is refused instead of filed elsewhere", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("hint10"));
	await waitWorkspaceReady(page);
	await firstBlankList(page, "Chores");

	const input = page.getByTestId("new-task");
	await input.fill("Sweep ~Nowhere");
	await expect(page.getByText("No list named Nowhere")).toBeVisible();
	await expect(page.getByTestId("new-task-submit")).toBeDisabled();
	await input.press("Enter");
	await expect(input).toHaveValue("Sweep ~Nowhere");
	await expect(page.getByTestId("list-empty")).toBeVisible();
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

test("on a phone a blank first list focuses the inline field with no help block", async ({
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
	await expect(page.getByTestId("syntax-hint")).toHaveCount(0);
	await ctx.close();
});
