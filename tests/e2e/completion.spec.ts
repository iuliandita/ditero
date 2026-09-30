import { expect, type Page, test } from "@playwright/test";
import {
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

// Completion feedback (#348): a checked row stays in place briefly, then
// settles into the collapsed completed group, and the shared snackbar offers
// Undo for the completion.

async function openNewList(page: Page, name: string): Promise<void> {
	await waitWorkspaceReady(page);
	await page.getByTestId("sidebar-create").click();
	await page.getByTestId("sidebar-new-list").click();
	await page.getByTestId("new-list").fill(name);
	await page.getByTestId("new-list-submit").click();
	const nav = sidebarLists(page).getByRole("button", { name, exact: true });
	await expect(nav.first()).toBeVisible({ timeout: 15000 });
	await nav.last().click();
	await expect(page.getByTestId("list")).toBeVisible();
}

async function addTask(page: Page, title: string): Promise<void> {
	await page.getByTestId("new-task").fill(title);
	await page.getByTestId("new-task-submit").click();
	await expect(
		page.getByTestId("list").getByText(title, { exact: true }),
	).toBeVisible({ timeout: 15000 });
}

test("a completed row settles into the group and Undo brings it back", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("settle"));
	await openNewList(page, "Settle");
	await addTask(page, "Stays open");
	await addTask(page, "Check me");
	const list = page.getByTestId("list");
	const row = list.getByRole("checkbox", { name: "Check me" });
	const section = list.getByTestId("completed-section");

	await row.check();
	const snackbar = page.getByTestId("snackbar");
	await expect(snackbar).toContainText("Completed: Check me");
	await expect(page.getByTestId("snackbar-live")).toHaveText(
		"Completed: Check me",
	);
	await expect
		.poll(() =>
			row.evaluate(
				(el) =>
					getComputedStyle(
						el.querySelector('[data-slot="checkbox-indicator"]') as Element,
					).animationName,
			),
		)
		.toBe("check-pop");
	// Settling: still in place and checked, so an accidental tap is visible.
	await expect(row).toBeChecked();
	await expect(section).toHaveCount(0);

	await expect(section).toHaveText(/1 item completed/, { timeout: 5000 });
	await expect(section).toHaveAttribute("aria-expanded", "false");
	await expect(row).toHaveCount(0);
	await expect(
		list.getByRole("checkbox", { name: "Stays open" }),
	).toBeVisible();

	await snackbar.getByTestId("snackbar-action").click();
	await expect(snackbar).toHaveCount(0);
	await expect(row).not.toBeChecked();
	await expect(section).toHaveCount(0);
});

test("x completes the focused row, focus moves on, Ctrl+Z undoes", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("settle-x"));
	await openNewList(page, "SettleKeys");
	await addTask(page, "Row A");
	await addTask(page, "Row B");
	const list = page.getByTestId("list");
	const navs = list.locator("[data-kbd-nav]");
	await expect(navs).toHaveCount(2);

	await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
	await page.keyboard.press("j");
	await expect(navs.nth(0)).toBeFocused();
	await page.keyboard.press("x");
	await expect(page.getByTestId("snackbar")).toContainText("Completed: Row A");
	await expect(list.getByRole("checkbox", { name: "Row A" })).toBeChecked();

	// Once Row A settles away, focus lands on the row that stays, not <body>.
	await expect(list.getByTestId("completed-section")).toBeVisible({
		timeout: 5000,
	});
	await expect(navs).toHaveCount(1);
	await expect(navs.nth(0)).toBeFocused();
	await expect(navs.nth(0)).toHaveText("Row B");

	await page.keyboard.press("Control+z");
	await expect(page.getByTestId("snackbar")).toHaveCount(0);
	await expect(list.getByRole("checkbox", { name: "Row A" })).not.toBeChecked();
	await expect(list.getByTestId("completed-section")).toHaveCount(0);
});

test("reduced motion: completion is instant and still settles", async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await signUp(page, uniqueEmail("settle-rm"));
	await openNewList(page, "SettleCalm");
	await addTask(page, "Calm");
	const list = page.getByTestId("list");
	const box = list.getByRole("checkbox", { name: "Calm" });

	await box.check();
	await expect(box).toBeChecked();
	// Measured on the rendered frame: no strike transition, no check animation.
	const title = list.getByText("Calm", { exact: true });
	expect(
		await title.evaluate(
			(el) => getComputedStyle(el, "::after").transitionProperty,
		),
	).toBe("none");
	expect(
		await box.evaluate(
			(el) =>
				getComputedStyle(
					el.querySelector('[data-slot="checkbox-indicator"]') as Element,
				).animationName,
		),
	).toBe("none");
	await expect(title).toHaveCount(1);
	await expect(page.getByTestId("snackbar")).toBeVisible();

	await expect(list.getByTestId("completed-section")).toHaveText(
		/1 item completed/,
		{ timeout: 5000 },
	);
	await page.getByTestId("snackbar-action").click();
	await expect(box).not.toBeChecked();
});

test("a snack that replaces another under a resting pointer waits for it to leave", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("settle-hover"));
	await openNewList(page, "SettleHover");
	for (const t of ["Row A", "Row B", "Row C"]) await addTask(page, t);
	const snackbar = page.getByTestId("snackbar");

	await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
	await page.keyboard.press("j");
	await page.keyboard.press("x");
	await expect(snackbar).toContainText("Completed: Row A");
	await snackbar.hover();
	// Row A settles and focus moves to Row B; complete it without moving the
	// pointer, so no pointerenter fires for the replacement snack.
	await expect(
		page.getByTestId("list").getByTestId("completed-section"),
	).toBeVisible({
		timeout: 5000,
	});
	await page.keyboard.press("x");
	// The outgoing snack overlaps its replacement for its short exit, so read
	// the live region, then require the replacement alone on screen.
	const live = page.getByTestId("snackbar-live");
	await expect(live).toHaveText("Completed: Row B");
	await expect(snackbar).toHaveCount(1);
	await page.waitForTimeout(6500);
	await expect(snackbar).toHaveCount(1);
	await expect(snackbar).toContainText("Completed: Row B");

	await page.mouse.move(5, 5);
	await expect(snackbar).toHaveCount(0, { timeout: 7000 });
});

test("reopening a task from a view retracts its Completed snack", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("settle-view"));
	await openNewList(page, "SettleView");
	await addTask(page, "View row");
	await sidebarLists(page)
		.getByRole("button", { name: "All tasks", exact: true })
		.click();
	const box = page.getByRole("checkbox", { name: "View row" });
	await expect(box).toBeVisible({ timeout: 15000 });
	const snackbar = page.getByTestId("snackbar");

	await box.check();
	await expect(snackbar).toContainText("Completed: View row");
	await box.uncheck();
	// Well inside the 5s auto-dismiss, so only the retraction can clear it.
	await expect(snackbar).toHaveCount(0, { timeout: 2000 });
	await expect(box).not.toBeChecked();
});

test("a reopen on another device retracts the Completed snack", async ({
	browser,
}) => {
	const email = uniqueEmail("settle-remote");
	const a = await browser.newContext();
	const b = await browser.newContext();
	try {
		const pa = await a.newPage();
		const pb = await b.newPage();
		await signUp(pa, email);
		await pb.goto("/");
		await pb.getByTestId("email").fill(email);
		await pb.getByTestId("password").fill("pw-123456");
		await pb.getByTestId("signin").click();
		await expect(pb.getByTestId("workspace")).toBeVisible({ timeout: 15000 });

		await openNewList(pa, "Devices");
		await addTask(pa, "Shared row");
		await sidebarLists(pb)
			.getByRole("button", { name: "Devices", exact: true })
			.last()
			.click();
		const listB = pb.getByTestId("list");
		await expect(listB.getByText("Shared row", { exact: true })).toBeVisible({
			timeout: 15000,
		});

		const snackbar = pa.getByTestId("snackbar");
		await pa
			.getByTestId("list")
			.getByRole("checkbox", { name: "Shared row" })
			.check();
		await expect(snackbar).toContainText("Completed: Shared row");
		// Hovering pauses the auto-dismiss, so the snack can only leave by retraction.
		await snackbar.hover();

		const sectionB = listB.getByTestId("completed-section");
		await expect(sectionB).toBeVisible({ timeout: 15000 });
		await sectionB.click();
		await listB.getByRole("checkbox", { name: "Shared row" }).uncheck();
		await expect(snackbar).toHaveCount(0, { timeout: 15000 });
	} finally {
		await a.close();
		await b.close();
	}
});

test("when the last open row settles, focus lands on the completed group", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("settle-last"));
	await openNewList(page, "SettleLast");
	await addTask(page, "Only row");
	const list = page.getByTestId("list");

	await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
	await page.keyboard.press("j");
	await expect(list.locator("[data-kbd-nav]")).toBeFocused();
	await page.keyboard.press("x");
	const section = list.getByTestId("completed-section");
	await expect(section).toBeVisible({ timeout: 5000 });
	await expect(section).toBeFocused();
});
