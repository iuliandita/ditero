import AxeBuilder from "@axe-core/playwright";
import {
	type Browser,
	expect,
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import {
	openMobileLists,
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

// Task rows on touch (#358) and their accessible shape (#359). The touch cases
// run with hasTouch, so (pointer: coarse) really matches; the first assertion
// of each proves that, or every "hidden on touch" check below would pass on a
// desktop layout for the wrong reason.

test.describe.configure({ timeout: 120_000 });

async function expectNoSeriousA11y(page: Page, surface: string) {
	await page.addStyleTag({
		content:
			"*,*::before,*::after{animation:none!important;transition:none!important}",
	});
	const { violations } = await new AxeBuilder({ page }).analyze();
	const serious = violations.filter(
		(v) => v.impact === "serious" || v.impact === "critical",
	);
	expect(
		serious.map((v) => v.id),
		`serious/critical a11y violations on ${surface}`,
	).toEqual([]);
}

async function phone(browser: Browser) {
	const ctx = await browser.newContext({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});
	const page = await ctx.newPage();
	await signUp(page, uniqueEmail("rows-touch"));
	await waitWorkspaceReady(page);
	expect(
		await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
	).toBe(true);
	await openMobileLists(page);
	await page.getByRole("button", { name: "New list" }).click();
	await page.getByTestId("new-list").fill("Errands");
	await page.getByTestId("new-list-submit").click();
	await page
		.getByTestId("list-index")
		.getByRole("button", { name: "Errands", exact: true })
		.click();
	await expect(page.getByTestId("list")).toBeVisible({ timeout: 15000 });
	return { ctx, page };
}

async function inlineAdd(page: Page, title: string) {
	await page.getByTestId("new-task").fill(title);
	await page.getByTestId("new-task-submit").click();
	await expect(
		page.getByTestId("list").getByRole("checkbox", { name: title }),
	).toBeVisible({ timeout: 15000 });
}

function rowOf(page: Page, title: string): Locator {
	return page
		.getByTestId("list")
		.locator("[data-kbd-row]")
		.filter({ has: page.getByRole("checkbox", { name: title, exact: true }) });
}

// A control kept only as a keyboard tab stop is clipped to the 1px sr-only box:
// present in the DOM (so a missing element cannot pass this) but not a target.
async function expectOutOfLayout(control: Locator) {
	await expect(control).toHaveCount(1);
	const box = await control.boundingBox();
	expect(box?.width ?? 0).toBeLessThanOrEqual(1);
}

// Chromium synthesizes pointer events from CDP touches, which is what the
// long-press listens to; Playwright's touchscreen API only offers a tap.
async function longPress(
	page: Page,
	target: Locator,
	whileHeld?: () => Promise<void>,
) {
	const box = await target.boundingBox();
	if (!box) throw new Error("long-press target has no box");
	const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Input.dispatchTouchEvent", {
		type: "touchStart",
		touchPoints: [point],
	});
	await page.waitForTimeout(700);
	await whileHeld?.();
	await cdp.send("Input.dispatchTouchEvent", {
		type: "touchEnd",
		touchPoints: [],
	});
	await cdp.detach();
}

test("touch rows show only checkbox, title and one cue; long-press opens actions", async ({
	browser,
}) => {
	const { ctx, page } = await phone(browser);
	await inlineAdd(page, "Buy stamps");
	await inlineAdd(page, "Post the parcel");
	const row = rowOf(page, "Buy stamps");

	await expectOutOfLayout(row.getByTestId("row-actions"));
	await expectOutOfLayout(page.getByTestId("task-drag").first());

	const background = () =>
		row.evaluate((el) => getComputedStyle(el).backgroundColor);
	const resting = await background();
	// The held row takes a fill before the menu opens: the computed value, not
	// the class, since an undeclared variant would leave the class inert.
	await longPress(
		page,
		row.getByRole("button", { name: "Open details" }),
		async () => {
			await expect.poll(background).not.toBe(resting);
		},
	);
	const menu = page.locator('[role="menu"]');
	await expect(menu).toBeVisible();
	await expect(menu.getByTestId("row-action-delete")).toBeVisible();
	// The lifted finger's synthesized tap must not also open the row behind.
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);

	// A plain tap afterwards still opens the detail: the guard is spent on the
	// long-press's own lift and does not eat the next real tap.
	await row.getByRole("button", { name: "Open details" }).tap();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);

	await expectNoSeriousA11y(page, "touch list");
	await ctx.close();
});

// Android can answer a held finger with contextmenu and then pointercancel
// instead of pointerup. Dispatched by hand because no emulated engine produces
// that order.
test("an Android-order long-press opens the menu once and keeps it open", async ({
	browser,
}) => {
	const { ctx, page } = await phone(browser);
	await inlineAdd(page, "Buy stamps");
	const open = rowOf(page, "Buy stamps").getByRole("button", {
		name: "Open details",
	});
	await open.evaluate(async (el) => {
		const box = el.getBoundingClientRect();
		const at = {
			bubbles: true,
			cancelable: true,
			clientX: box.x + 20,
			clientY: box.y + box.height / 2,
			pointerId: 7,
			pointerType: "touch",
			isPrimary: true,
		};
		el.dispatchEvent(new PointerEvent("pointerdown", at));
		await new Promise((r) => setTimeout(r, 600));
		el.dispatchEvent(new MouseEvent("contextmenu", at));
		await new Promise((r) => setTimeout(r, 50));
		el.dispatchEvent(new PointerEvent("pointercancel", at));
	});
	const menu = page.locator('[role="menu"]');
	await expect(menu).toHaveCount(1);
	await page.waitForTimeout(300);
	await expect(menu).toHaveCount(1);
	await expect(menu.getByTestId("row-action-delete")).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await ctx.close();
});

test("reorder mode shows full-size grips on touch; Done hides them", async ({
	browser,
}) => {
	const { ctx, page } = await phone(browser);
	await inlineAdd(page, "First");
	await inlineAdd(page, "Second");
	const grip = page.getByTestId("task-drag").first();
	await expectOutOfLayout(grip);

	await page.getByRole("button", { name: "List display options" }).click();
	await page.getByTestId("reorder-mode").click();
	await expect(page.getByTestId("reorder-bar")).toBeVisible();
	const box = await grip.boundingBox();
	// 44px, less subpixel rounding.
	expect(box?.width ?? 0).toBeGreaterThanOrEqual(43.5);
	expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);

	await page
		.getByTestId("reorder-bar")
		.getByRole("button", { name: "Done" })
		.click();
	await expect(page.getByTestId("reorder-bar")).toHaveCount(0);
	await expectOutOfLayout(grip);
	await ctx.close();
});

test("inline add sits after the rows and nothing floating covers the last row", async ({
	browser,
}) => {
	const { ctx, page } = await phone(browser);
	const titles = Array.from({ length: 12 }, (_, i) => `Errand ${i + 1}`);
	for (const t of titles) await inlineAdd(page, t);

	const field = page.getByTestId("new-task");
	const last = rowOf(page, titles.at(-1) as string);
	const fieldBox = await field.boundingBox();
	const lastBox = await last.boundingBox();
	if (!fieldBox || !lastBox) throw new Error("missing boxes");
	expect(fieldBox.y).toBeGreaterThan(lastBox.y);

	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	await page.waitForTimeout(300);
	const fab = await page
		.getByRole("button", { name: "Quick add", exact: true })
		.boundingBox();
	const fieldAtEnd = await field.boundingBox();
	const lastAtEnd = await last.boundingBox();
	if (!fab || !fieldAtEnd || !lastAtEnd) throw new Error("missing boxes");
	expect(fieldAtEnd.y + fieldAtEnd.height).toBeLessThanOrEqual(fab.y);
	expect(lastAtEnd.y + lastAtEnd.height).toBeLessThanOrEqual(fab.y);

	// Completing a row raises the snackbar above the button; the remaining last
	// open row must still clear it.
	await rowOf(page, titles[0]).getByRole("checkbox").tap();
	const snack = page.getByTestId("snackbar");
	await expect(snack).toBeVisible();
	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	await page.waitForTimeout(300);
	const snackBox = await snack.boundingBox();
	const lastWithSnack = await last.boundingBox();
	if (!snackBox || !lastWithSnack) throw new Error("missing boxes");
	expect(lastWithSnack.y + lastWithSnack.height).toBeLessThanOrEqual(
		snackBox.y,
	);
	await ctx.close();
});

test("a row announces its title once, with labeled subtask progress and priority", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("rows-a11y"));
	await waitWorkspaceReady(page);
	await page.getByTestId("create-list-open").click();
	await page.getByTestId("new-list").fill("Chores");
	await page.getByTestId("new-list-submit").click();
	const nav = sidebarLists(page).getByRole("button", {
		name: "Chores",
		exact: true,
	});
	await expect(nav.first()).toBeVisible({ timeout: 15000 });
	await nav.last().click();
	await page.getByTestId("new-task").fill("Fix the gate");
	await page.getByTestId("new-task-submit").click();

	const row = rowOf(page, "Fix the gate");
	await expect(row).toHaveCount(1, { timeout: 15000 });
	await row.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Priority" }).click();
	await page.getByRole("menuitem", { name: "P1 High", exact: true }).click();
	await expect(page.locator('[role="menu"]')).toHaveCount(0);

	const open = row.getByRole("button", { name: "Open details" });
	await open.click();
	const detail = page.getByRole("dialog");
	for (const child of ["Buy hinges", "Sand the post", "Paint it"]) {
		await detail.getByPlaceholder("Add subtask").fill(child);
		await detail.getByPlaceholder("Add subtask").press("Enter");
		await expect(detail.getByText(child, { exact: true })).toBeVisible();
	}
	// Focus is in a field; Escape would only leave it. Close explicitly.
	await detail.getByTestId("task-detail-close").click();
	await expect(detail).toHaveCount(0);
	await row.getByRole("button", { name: "Expand subtasks" }).click();
	await page
		.getByTestId("list")
		.getByRole("checkbox", { name: "Buy hinges" })
		.check();

	// One labelled control carries the title and state; the open control names
	// its action instead of repeating the title.
	await expect(
		row.getByRole("checkbox", { name: "Fix the gate", exact: true }),
	).toHaveCount(1);
	// The kebab's "Actions for Fix the gate" names its menu, not the task.
	await expect(row.getByRole("button", { name: /^Fix the gate/ })).toHaveCount(
		0,
	);
	await expect(open).toHaveAccessibleDescription(
		/1 of 3 subtasks done.*Priority: P1 High/,
		{ timeout: 15000 },
	);
	const names = await row.evaluate((el) =>
		Array.from(el.querySelectorAll<HTMLElement>("button,[role=checkbox]")).map(
			(c) => c.getAttribute("aria-label") ?? c.textContent ?? "",
		),
	);
	expect(names.filter((n) => n.startsWith("Fix the gate"))).toHaveLength(1);

	const count = row.getByTestId("subtask-count");
	await expect(count).toContainText("1/3");
	await expect(count.locator("svg")).toHaveCount(1);

	const flag = row.getByRole("img", { name: "Priority: P1 High" });
	await expect(flag).toBeVisible();
	await expect(flag).toHaveAttribute("data-priority", "3");
	// High is the solid flag; medium is tinted and low open, so the level reads
	// without its hue.
	expect(
		await flag.locator("svg").evaluate((el) => getComputedStyle(el).fill),
	).not.toBe("none");
	const text = row.getByTestId("task-priority-text");
	await page.mouse.move(0, 0);
	await expect(text).toBeHidden();
	await row.hover();
	await expect(text).toHaveText("P1 High");

	await expectNoSeriousA11y(page, "list rows");
});
