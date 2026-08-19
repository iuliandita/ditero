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

// --- Scenario 3: the boot gates render a silhouette, never a blank page ---
test("boot: session and sync gates render skeletons, then hand off to the shell", async ({
	page,
}) => {
	const email = uniqueEmail("e3");
	await signUp(page, email);

	// Both gates are normally sub-second, so the only way to observe them is to
	// hold the request each one waits on: the session probe (App) and the account
	// bootstrap the Zero provider awaits before it constructs a client.
	await page.route("**/api/auth/get-session*", async (route) => {
		await new Promise((r) => setTimeout(r, 2000));
		await route.continue();
	});
	await page.route("**/api/bootstrap", async (route) => {
		await new Promise((r) => setTimeout(r, 4000));
		await route.continue();
	});

	await page.goto("/");
	await expect(page.getByTestId("boot-skeleton")).toBeVisible();
	await expect(page.getByTestId("shell-skeleton")).toBeVisible({
		timeout: 15000,
	});
	// Paired with the two absences below: the shell really does arrive, so the
	// skeletons going away is a handoff and not a page that never rendered.
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30000 });
	await expect(page.getByTestId("boot-skeleton")).toHaveCount(0);
	await expect(page.getByTestId("shell-skeleton")).toHaveCount(0);
});

// --- Scenario 4: an unfinished initial sync is a skeleton, never an empty state ---
// Zero delivers query completeness over the zero-cache websocket, so the only
// way to hold a query at "unknown" is to mock that socket's peer: the client
// connects, and the initial poke never arrives.
test("sync: an incomplete query renders the row skeleton, not an empty state", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("e4"));

	let hold = true;
	await page.routeWebSocket(/\/sync\/v\d+\/connect/, (ws) => {
		// Not connecting to the real server leaves Playwright as the peer: the
		// socket opens and stays silent. Connecting forwards both directions.
		if (!hold) ws.connectToServer();
	});

	await page.goto("/");
	await expect(page.getByTestId("view-surface")).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByTestId("task-list-skeleton")).toBeVisible();
	// The defect: with no rows and no completeness, the surface used to claim the
	// user was new. Both empty states must stay away until the query settles.
	await expect(page.getByTestId("view-empty-first-use")).toHaveCount(0);
	await expect(page.getByTestId("view-empty-no-match")).toHaveCount(0);

	// Presence half: released, the same surface settles into the first-use state,
	// so the absences above were a held query and not a page that never rendered.
	hold = false;
	await page.reload();
	await expect(page.getByTestId("view-empty-first-use")).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByTestId("task-list-skeleton")).toHaveCount(0);
});

// ListView's identical gate has no equivalent test on purpose. Reaching the
// list surface means clicking a list in the sidebar, which needs lists.mine()
// complete; ListView derives tasksLoading as `listsLoading || tasks not
// complete` from the same two query instances Workspace holds, and zero-cache
// answers both in one atomic poke. So the surface is only reachable once the
// branch under test is already false.
