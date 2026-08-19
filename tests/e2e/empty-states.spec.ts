import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

// Empty-state e2e. The defect these guard is that the app could not tell "not
// synced yet" from "genuinely empty" and rendered neither, so every absence
// assertion below is paired with a presence assertion on the same surface --
// otherwise a blank page passes both halves for free.

test.describe.configure({ timeout: 90_000 });

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

async function createList(page: Page, name: string): Promise<void> {
	await page.getByTestId("new-list").fill(name);
	await page.getByTestId("new-list-submit").click();
	await expect(
		sidebarLists(page).getByRole("button", { name, exact: true }).first(),
	).toBeVisible({ timeout: 15000 });
}

// --- Scenario 1: the landing separates first use from a filter that matched ---
test("view: a new user is onboarded, then told calmly that nothing matched", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("e1"));
	await waitWorkspaceReady(page);

	// Landing = the Today built-in. With no tasks anywhere this is first use.
	const surface = page.getByTestId("view-surface");
	await expect(surface).toBeVisible();
	await expect(page.getByTestId("view-empty-first-use")).toBeVisible({
		timeout: 15000,
	});
	await expect(page.getByTestId("view-empty-no-match")).toHaveCount(0);
	await expectNoSeriousA11y(page, "view first-use empty state");

	// One undated task exists now, so the user is no longer new -- but Today
	// filters to due/overdue, so it still matches nothing. The two states must
	// swap: this is the presence half that makes the absence half load-bearing.
	await createList(page, "Groceries");
	await sidebarLists(page)
		.getByRole("button", { name: "Groceries", exact: true })
		.last()
		.click();
	await expect(page.getByTestId("list")).toBeVisible();
	await page.getByTestId("new-task").fill("Buy milk");
	await page.getByTestId("new-task-submit").click();
	await expect(
		page.getByTestId("list").getByText("Buy milk", { exact: true }),
	).toBeVisible({ timeout: 15000 });

	await sidebarLists(page)
		.getByRole("button", { name: "Today", exact: true })
		.click();
	await expect(surface).toBeVisible();
	await expect(page.getByTestId("view-empty-no-match")).toBeVisible({
		timeout: 15000,
	});
	await expect(page.getByTestId("view-empty-first-use")).toHaveCount(0);
	await expectNoSeriousA11y(page, "view no-match empty state");

	// A view the task DOES match renders rows and neither empty state.
	await sidebarLists(page)
		.getByRole("button", { name: "All my tasks", exact: true })
		.click();
	await expect(surface.getByText("Buy milk", { exact: true })).toBeVisible({
		timeout: 15000,
	});
	await expect(page.getByTestId("view-empty-no-match")).toHaveCount(0);
	await expect(page.getByTestId("view-empty-first-use")).toHaveCount(0);
});

// --- Scenario 2: an empty list says so, and its CTA reaches the add field ---
test("list: an empty list renders an empty state whose CTA focuses the input", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("e2"));
	await waitWorkspaceReady(page);
	await createList(page, "Chores");
	await sidebarLists(page)
		.getByRole("button", { name: "Chores", exact: true })
		.last()
		.click();

	const listSurface = page.getByTestId("list");
	await expect(listSurface).toBeVisible();
	// Presence, not just "no rows": an empty <ul> would have satisfied the old
	// code and shown nothing at all.
	await expect(page.getByTestId("list-empty")).toBeVisible({ timeout: 15000 });
	await expectNoSeriousA11y(page, "list empty state");

	await page.getByTestId("list-empty-add").click();
	await expect(page.getByTestId("new-task")).toBeFocused();

	await page.keyboard.type("Sweep the floor");
	await page.getByTestId("new-task-submit").click();
	// Paired: the row appears AND the empty state goes.
	await expect(
		listSurface.getByText("Sweep the floor", { exact: true }),
	).toBeVisible({ timeout: 15000 });
	await expect(page.getByTestId("list-empty")).toHaveCount(0);
});
