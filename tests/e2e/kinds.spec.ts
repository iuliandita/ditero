import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

// Each list kind reads as itself (#352): its own add verb, shopping quantity
// only when set, habits that start daily with one Done label, and a labeled
// project progress count.
test.describe.configure({ retries: 2, timeout: 90_000 });

async function expectNoSeriousA11y(page: Page, surface: string): Promise<void> {
	await page.addStyleTag({
		content:
			"*,*::before,*::after{animation:none!important;transition:none!important}",
	});
	const { violations } = await new AxeBuilder({ page }).analyze();
	const serious = violations.filter(
		(v) => v.impact === "serious" || v.impact === "critical",
	);
	if (serious.length > 0)
		console.error(
			`a11y[${surface}] serious/critical:`,
			JSON.stringify(
				serious.map((v) => ({ id: v.id, nodes: v.nodes.length })),
				null,
				2,
			),
		);
	expect(serious, `serious/critical a11y violations on ${surface}`).toEqual([]);
}

// From the landing, where the create-list form lives.
async function createKindList(
	page: Page,
	name: string,
	kind: string,
): Promise<void> {
	await waitWorkspaceReady(page);
	await page.getByTestId("create-list-open").click();
	await page.getByTestId("new-list").fill(name);
	await page.getByRole("button", { name: kind, exact: true }).click();
	await page.getByTestId("new-list-submit").click();
	await expect(
		sidebarLists(page).getByRole("button", { name, exact: true }).first(),
	).toBeVisible({ timeout: 15000 });
}

async function openList(page: Page, name: string): Promise<void> {
	await sidebarLists(page)
		.getByRole("button", { name, exact: true })
		.first()
		.click();
	await expect(
		page.getByTestId("list").getByRole("heading", { name }),
	).toBeVisible();
}

async function add(page: Page, title: string, action: string): Promise<void> {
	await page.getByTestId("new-task").fill(title);
	const submit = page.getByTestId("new-task-submit");
	await expect(submit).toHaveText(action);
	await submit.click();
	await expect(
		page.getByTestId("list").getByText(title, { exact: true }),
	).toBeVisible({ timeout: 15000 });
}

test("shopping: add item verb, quantity only when set, no lone Other header", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("kind-shop"));
	await createKindList(page, "Market", "Shopping");
	await openList(page, "Market");

	await expect(page.getByTestId("new-task")).toHaveAttribute(
		"placeholder",
		"Add an item",
	);
	await add(page, "Oat milk", "Add item");

	const list = page.getByTestId("list");
	await expect(list.getByRole("checkbox", { name: "Oat milk" })).toBeVisible();
	// No category anywhere: one plain run, no "Other" header, no empty fields.
	await expect(list.getByText("Other", { exact: true })).toHaveCount(0);
	await expect(
		list.locator("input[aria-label='Quantity for Oat milk']"),
	).toHaveCount(0);

	await list.getByText("Oat milk", { exact: true }).hover();
	await list
		.getByRole("button", { name: "Qty, add quantity for Oat milk" })
		.click();
	const qty = list.locator("input[aria-label='Quantity for Oat milk']");
	await expect(qty).toBeFocused();
	// A bad quantity keeps the fields open with the reason, nothing is saved.
	await qty.fill("-1");
	await qty.press("Enter");
	await expect(list.getByTestId("shopping-qty-error")).toHaveText(
		"Enter a number above 0, like 2 or 1.5",
	);
	await expect(qty).toBeFocused();
	await expect(qty).toHaveAttribute("aria-invalid", "true");
	await expect(list.getByTestId("shopping-qty-chip")).toHaveCount(0);
	await qty.fill("2");
	await list.locator("input[aria-label='Unit for Oat milk']").fill("L");
	await expectNoSeriousA11y(page, "shopping quantity fields");
	await qty.press("Enter");

	const chip = list.getByTestId("shopping-qty-chip");
	await expect(chip).toHaveText("2 L", { timeout: 15000 });
	await expect(chip).toBeFocused();
	await expect(qty).toHaveCount(0);
	await expect(
		list.getByRole("button", { name: "2 L, edit quantity for Oat milk" }),
	).toBeVisible();
});

test("checklist and project: kind verbs and a labeled project progress count", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("kind-proj"));
	await createKindList(page, "Packing", "Checklist");
	await createKindList(page, "Launch", "Project");
	await openList(page, "Packing");
	await expect(page.getByTestId("new-task")).toHaveAttribute(
		"placeholder",
		"Add an item",
	);
	await add(page, "Passport", "Add item");

	await openList(page, "Launch");
	await expect(page.getByTestId("new-task")).toHaveAttribute(
		"placeholder",
		"Add a task",
	);
	const list = page.getByTestId("list");
	// No tasks, no count: the header only speaks once there is something to count.
	await expect(list.getByTestId("list-progress")).toHaveCount(0);
	await add(page, "Write brief", "Add task");
	await add(page, "Ship it", "Add task");
	await list.getByRole("checkbox", { name: "Write brief" }).click();

	const progress = list.getByTestId("list-progress");
	await expect(progress).toHaveText("1 of 2 done", { timeout: 15000 });
	const bar = list.getByRole("progressbar", { name: "1 of 2 done" });
	await expect(bar).toHaveAttribute("aria-valuenow", "50");

	const sideBar = sidebarLists(page).getByRole("progressbar", {
		name: "1 of 2 done",
	});
	await expect(sideBar).toHaveAttribute("title", "1 of 2 done");
	await expectNoSeriousA11y(page, "project list");
});

test("habits: add habit verb, new habits start daily, one Done label, Undo only after logging", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("kind-habit"));
	await createKindList(page, "Routines", "Habits");
	await openList(page, "Routines");

	await expect(page.getByTestId("new-task")).toHaveAttribute(
		"placeholder",
		"Add a habit",
	);
	await add(page, "Stretch", "Add habit");

	const card = page.getByTestId("habit-card").filter({ hasText: "Stretch" });
	// Started daily: the tracker renders, no recurrence dead end.
	await expect(card.getByTestId("habit-streak")).toHaveText("0 days", {
		timeout: 15000,
	});
	await expect(card.getByTestId("habit-track-daily")).toHaveCount(0);
	// Days before the habit existed are not misses: one pending cell, no score.
	await expect(card.getByTestId("habit-heatmap").getByRole("img")).toHaveCount(
		1,
	);
	await expect(card.getByRole("img", { name: /: upcoming$/ })).toBeVisible();
	await expect(card.getByTestId("habit-adherence")).toHaveCount(0);

	const done = card.getByTestId("habit-done");
	await expect(done).toHaveText("Done today");
	await expect(done).toHaveAttribute("aria-pressed", "false");
	await expect(card.getByTestId("habit-skip")).toBeVisible();
	await expect(card.getByTestId("habit-undo")).toHaveCount(0);

	await done.click();
	await expect(done).toHaveAttribute("aria-pressed", "true");
	await expect(done).toHaveText("Done today");
	await expect(card.getByRole("button", { name: "Done today" })).toBeVisible();

	const undo = card.getByTestId("habit-undo");
	await expect(undo).toBeVisible();
	await undo.click();
	await expect(done).toHaveAttribute("aria-pressed", "false");
	await expect(undo).toHaveCount(0);
	await expect(done).toBeFocused();
});
