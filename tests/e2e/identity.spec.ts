import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import {
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

// Visual identity (#350): the first-run welcome's actions, the checkbox shape
// and priority-tone rule, and the axe gate in both themes. Colors are read off
// computed styles, never class names: a class can compile to nothing.

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

// A tasks list with one task per priority plus a done one, and a shopping list,
// straight into the personal workspace. zero-cache replicates the rows.
async function seedLists(email: string): Promise<void> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		const { rows } = await pool.query<{ wsId: string; ownerId: string }>(
			`select w.id as "wsId", w.owner_id as "ownerId"
			 from workspace w join "user" u on u.id = w.owner_id
			 where u.email = $1 and w.kind = 'personal'`,
			[email],
		);
		const row = rows[0];
		if (!row) throw new Error("personal workspace not found");
		const tasksId = crypto.randomUUID();
		const shopId = crypto.randomUUID();
		await pool.query(
			`insert into list (id, workspace_id, owner_id, title, kind, sort_key)
			 values ($1, $2, $3, 'Home', 'tasks', 'a0'),
			        ($4, $2, $3, 'Market', 'shopping', 'a1')`,
			[tasksId, row.wsId, row.ownerId, shopId],
		);
		const tasks: [string, number, boolean][] = [
			["Urgent thing", 3, false],
			["Medium thing", 2, false],
			["Low thing", 1, false],
			["Plain thing", 0, false],
			["Finished thing", 2, true],
		];
		for (const [i, [title, priority, done]] of tasks.entries())
			await pool.query(
				`insert into task (id, list_id, title, sort_key, done, priority)
				 values ($1, $2, $3, $4, $5, $6)`,
				[crypto.randomUUID(), tasksId, title, `a${i}`, done, priority],
			);
		await pool.query(
			`insert into task (id, list_id, title, sort_key, done, priority)
			 values ($1, $2, 'Oat milk', 'a0', false, 0)`,
			[crypto.randomUUID(), shopId],
		);
	} finally {
		await pool.end();
	}
}

async function openList(page: Page, name: string, row: string): Promise<void> {
	const nav = sidebarLists(page).getByRole("button", { name, exact: true });
	await expect(nav.first()).toBeVisible({ timeout: 20000 });
	await nav.first().click();
	await expect(
		page.getByTestId("list").getByText(row, { exact: true }),
	).toBeVisible({ timeout: 20000 });
}

// Resolves a custom property to the same string computed styles report.
function tokenColor(page: Page, token: string): Promise<string> {
	return page.evaluate((t) => {
		const probe = document.createElement("span");
		probe.style.color = `var(${t})`;
		document.body.append(probe);
		const c = getComputedStyle(probe).color;
		probe.remove();
		return c;
	}, token);
}

// rounded-full compiles to an effectively infinite radius; compare to width.
function isRound(el: Locator): Promise<boolean> {
	return el.evaluate((node) => {
		const s = getComputedStyle(node);
		return parseFloat(s.borderTopLeftRadius) >= parseFloat(s.width) / 2;
	});
}

function box(page: Page, name: string) {
	return page.getByTestId("list").getByRole("checkbox", { name, exact: true });
}

test("first run: one primary action opens the list form, starters seed a list", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("id1"));
	await waitWorkspaceReady(page);

	const welcome = page.getByTestId("view-empty-first-use");
	await expect(welcome).toBeVisible({ timeout: 15000 });
	await expect(welcome.locator("svg.lucide-sparkles")).toHaveCount(0);
	const borderStyle = await welcome.evaluate(
		(el) => getComputedStyle(el).borderTopStyle,
	);
	expect(borderStyle).not.toBe("dashed");

	await page.getByTestId("first-run-create-list").click();
	await expect(page.getByTestId("new-list")).toBeFocused();

	await welcome.getByTestId("first-run-starter-shopping").click();
	await expect(box(page, "Milk")).toBeVisible({ timeout: 15000 });
	await expect(box(page, "Milk")).toHaveAttribute("data-shape", "square");
	await expect(
		sidebarLists(page).getByRole("button", { name: "Groceries", exact: true }),
	).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
	test(`checkboxes: tasks are round and carry priority, items stay square (${scheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const email = uniqueEmail(`id2${scheme}`);
		await signUp(page, email);
		await waitWorkspaceReady(page);
		await expect(page.getByTestId("view-empty-first-use")).toBeVisible({
			timeout: 15000,
		});
		await expectNoSeriousA11y(page, `first-run ${scheme}`);
		await seedLists(email);
		await openList(page, "Home", "Plain thing");

		const urgent = box(page, "Urgent thing");
		await expect(urgent).toHaveAttribute("data-shape", "round");
		expect(await isRound(urgent)).toBe(true);
		for (const [name, token] of [
			["Urgent thing", "--priority-3"],
			["Medium thing", "--priority-2"],
			["Low thing", "--priority-1"],
			["Plain thing", "--control-border"],
		] as const)
			await expect(box(page, name)).toHaveCSS(
				"border-top-color",
				await tokenColor(page, token),
			);
		// Done rows settle into the collapsed completed group; the rule holds
		// there too, and done fills with the tone, so the priority-2 box is solid.
		await page.getByTestId("list").getByTestId("completed-section").click();
		const finished = box(page, "Finished thing");
		await expect(finished).toBeVisible();
		await expect(finished).toHaveAttribute("data-shape", "round");
		expect(await isRound(finished)).toBe(true);
		await expect(finished).toHaveCSS(
			"background-color",
			await tokenColor(page, "--priority-2"),
		);
		await expectNoSeriousA11y(page, `task list ${scheme}`);

		await openList(page, "Market", "Oat milk");
		const milk = box(page, "Oat milk");
		await expect(milk).toHaveAttribute("data-shape", "square");
		expect(await isRound(milk)).toBe(false);
		await expectNoSeriousA11y(page, `shopping list ${scheme}`);
	});
}

// The welcome is for a user with no list anywhere. One empty list is enough to
// retire it: the landing then says the view matched nothing instead.
for (const viewport of [
	{ name: "desktop", width: 1280, height: 800 },
	{ name: "mobile", width: 375, height: 812 },
] as const) {
	test(`first run: the welcome is gone once any list exists (${viewport.name})`, async ({
		page,
	}) => {
		await page.setViewportSize({
			width: viewport.width,
			height: viewport.height,
		});
		await signUp(page, uniqueEmail(`id3${viewport.name}`));
		await waitWorkspaceReady(page);
		const welcome = page.getByTestId("view-empty-first-use");
		await expect(welcome).toBeVisible({ timeout: 15000 });

		if (viewport.name === "desktop")
			await page.getByTestId("create-list-open").click();
		else await page.getByRole("button", { name: "New list" }).click();
		await page.getByTestId("new-list").fill("Errands");
		await page.getByTestId("new-list-submit").click();

		await expect(page.getByTestId("view-empty-no-match")).toBeVisible({
			timeout: 15000,
		});
		await expect(welcome).toHaveCount(0);
		await expect(page.getByTestId("first-run-create-list")).toHaveCount(0);
	});
}
