import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { signUp, uniqueEmail, waitWorkspaceReady } from "./helpers.ts";

// The search tab used to be permanently disabled, explaining itself through a
// `title` tooltip on a surface that only exists on touch (#141). Every assertion
// here is behavioral for that reason: the tab's own attributes would have looked
// fine while a third of primary navigation still did nothing.

test.describe.configure({ timeout: 90_000 });

const PHONE = { width: 375, height: 812 };

async function expectNoSeriousA11y(page: Page, surface: string): Promise<void> {
	await page.addStyleTag({
		content:
			"*,*::before,*::after{animation:none!important;transition:none!important}",
	});
	const { violations } = await new AxeBuilder({ page }).analyze();
	const serious = violations.filter(
		(v) => v.impact === "serious" || v.impact === "critical",
	);
	const minor = violations.filter(
		(v) => v.impact !== "serious" && v.impact !== "critical",
	);
	if (minor.length > 0)
		console.log(
			`a11y[${surface}] moderate/minor:`,
			minor.map((v) => v.id).join(", "),
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

test("mobile search finds a task by substring and opens it", async ({
	browser,
}) => {
	const ctx = await browser.newContext({ viewport: PHONE });
	const page = await ctx.newPage();
	await signUp(page, uniqueEmail("msearch"));
	await waitWorkspaceReady(page);

	await page.getByRole("button", { name: "New list" }).click();
	await page.getByTestId("new-list").fill("Groceries");
	await page.getByTestId("new-list-submit").click();
	await page
		.getByRole("button", { name: "Groceries", exact: true })
		.first()
		.click();
	await expect(page.getByTestId("list")).toBeVisible({ timeout: 15000 });

	for (const title of ["Buy oat milk", "Call the plumber"]) {
		await page.getByTestId("new-task").fill(title);
		await page.getByTestId("new-task-submit").click();
		await expect(
			page.getByTestId("list").getByText(title, { exact: true }),
		).toBeVisible({ timeout: 15000 });
	}

	// Everything below runs with a Radix sheet open, so it locates by attribute
	// (testid / aria-label): role locators skip the aria-hidden app root.
	await page.getByTestId("nav-tab-search").click();
	const sheet = page.getByTestId("mobile-search");
	await expect(sheet).toBeVisible();

	// Empty query lists nothing -- paired with the populated assertion below, so
	// a sheet that could never render a row would not pass this for free.
	await expect(page.getByTestId("mobile-search-result")).toHaveCount(0);
	await expect(sheet.getByText("Type to search your tasks.")).toBeVisible();
	await expectNoSeriousA11y(page, "mobile search (empty)");

	const results = page.getByTestId("mobile-search-result");
	await page.getByTestId("mobile-search-input").fill("oat");
	await expect(results).toHaveCount(1);
	await expect(results.first()).toContainText("Buy oat milk");
	// Same query, the other task absent: the count above already proves the
	// query can match, so this is the discriminating half.
	await expect(sheet.getByText("Call the plumber")).toHaveCount(0);
	await expectNoSeriousA11y(page, "mobile search (results)");

	// A substring of the LIST title matches its tasks too (search.ts scores
	// title > list > notes), so both rows come back.
	await page.getByTestId("mobile-search-input").fill("grocer");
	await expect(results).toHaveCount(2);

	// A query that matches nothing keeps the surface, not a blank sheet.
	await page.getByTestId("mobile-search-input").fill("zzzznope");
	await expect(results).toHaveCount(0);
	await expect(sheet.getByText("No results")).toBeVisible();

	// Selecting a hit closes search and opens that task's detail sheet.
	await page.getByTestId("mobile-search-input").fill("plumber");
	await expect(results).toHaveCount(1);
	await results.first().click();
	await expect(sheet).toHaveCount(0);
	await expect(page.locator('input[aria-label="Task title"]')).toHaveValue(
		"Call the plumber",
		{ timeout: 15000 },
	);
});
