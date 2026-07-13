import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { Pool } from "pg";

// Task 10 cluster: NLP quick-add and drag reorder. Task 11 extends this file
// with the rest of the domain matrix (kinds, templates, a11y, isolation).
//
// Live cross-client sync is exercised with two browser contexts, sometimes the
// same user (personal/shared workspace) and sometimes two distinct users (the
// isolation scenario). The signup rate limit is relaxed under the e2e harness
// (DITERO_E2E, see src/auth/security.ts), so per-test signups are unconstrained.

const SHARED_WORKSPACE_ID = "w_shared_e2e";
const PASSWORD = "pw-123456";

async function signUp(page: Page, email: string): Promise<string> {
	await page.goto("/");
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill(PASSWORD);
	await page.getByTestId("signup").click();
	await expect(page.getByTestId("workspace")).toBeVisible();
	const session = await page.evaluate(async () => {
		const response = await fetch("/api/auth/get-session");
		return (await response.json()) as { user: { id: string } };
	});
	return session.user.id;
}

async function signIn(page: Page, email: string): Promise<void> {
	await page.goto("/");
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill(PASSWORD);
	await page.getByTestId("signin").click();
	await expect(page.getByTestId("workspace")).toBeVisible();
}

async function joinShared(userId: string): Promise<void> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await pool.query(
			`insert into membership (id, user_id, workspace_id, role)
			 values ($1, $2, $3, 'member')`,
			[crypto.randomUUID(), userId, SHARED_WORKSPACE_ID],
		);
	} finally {
		await pool.end();
	}
}

// Vertical order of two task rows on a page: true when Beta sits above Alpha.
async function betaAboveAlpha(page: Page): Promise<boolean> {
	const alpha = await page.getByText("Alpha", { exact: true }).boundingBox();
	const beta = await page.getByText("Beta", { exact: true }).boundingBox();
	return alpha != null && beta != null ? beta.y < alpha.y : false;
}

// Vertical order of two list-index rows: true when Zeta sits above Shared list.
async function zetaAboveShared(page: Page): Promise<boolean> {
	const zeta = await page.getByText("Zeta", { exact: true }).boundingBox();
	const shared = await page
		.getByText("Shared list", { exact: true })
		.boundingBox();
	return zeta != null && shared != null ? zeta.y < shared.y : false;
}

let emailSeq = 0;
function uniqueEmail(prefix: string): string {
	emailSeq += 1;
	return `${prefix}-${Date.now()}-${emailSeq}@t.dev`;
}

// Desktop sidebar list nav (aria-label "Lists") — scopes list-open clicks away
// from the create-list kind pills, which share their labels with list titles.
function sidebarLists(page: Page): Locator {
	return page.getByRole("navigation", { name: "Lists" });
}

// The personal workspace is provisioned in a post-signup hook and reaches the
// client via sync, so its name button appears a beat after the app shell. Wait
// for it before writing: an empty active workspace id makes list.create reject.
async function waitWorkspaceReady(page: Page): Promise<void> {
	await expect(page.getByRole("button", { name: /'s space/ })).toBeVisible({
		timeout: 15000,
	});
}

async function createListDesktop(
	page: Page,
	name: string,
	kindLabel?: string,
): Promise<void> {
	await waitWorkspaceReady(page);
	await page.getByTestId("new-list").fill(name);
	if (kindLabel)
		await page.getByRole("button", { name: kindLabel, exact: true }).click();
	await page.getByTestId("new-list-submit").click();
	await expect(
		sidebarLists(page).getByRole("button", { name, exact: true }).first(),
	).toBeVisible({ timeout: 15000 });
}

async function openListDesktop(page: Page, name: string): Promise<void> {
	await sidebarLists(page)
		.getByRole("button", { name, exact: true })
		.last()
		.click();
	await expect(page.getByTestId("list")).toBeVisible();
}

async function backToIndexDesktop(page: Page): Promise<void> {
	await page.getByRole("button", { name: /'s space/ }).click();
	await expect(page.getByTestId("new-list")).toBeVisible();
}

async function addTask(page: Page, title: string): Promise<void> {
	await page.getByTestId("new-task").fill(title);
	await page.getByTestId("new-task-submit").click();
	await expect(
		page.getByTestId("list").getByText(title, { exact: true }),
	).toBeVisible({ timeout: 15000 });
}

// True when `above` sits higher on the page than `below` (smaller y).
async function isAbove(
	scope: Locator,
	above: string,
	below: string,
): Promise<boolean> {
	const a = await scope.getByText(above, { exact: true }).boundingBox();
	const b = await scope.getByText(below, { exact: true }).boundingBox();
	return a != null && b != null ? a.y < b.y : false;
}

// Gate per design 2.14: zero serious/critical violations. Moderate/minor are
// logged for visibility but do not fail the merge.
async function expectNoSeriousA11y(page: Page, surface: string): Promise<void> {
	// Freeze animations so axe samples the settled frame, not a mid-fade opacity
	// (a half-faded sheet reads secondary text as lighter than its real token).
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

test("quick-add chips + drag reorder sync across clients", async ({
	browser,
}) => {
	const a = await browser.newContext();
	const b = await browser.newContext();
	const pa = await a.newPage();
	const pb = await b.newPage();

	const userId = await signUp(pa, "cara@t.dev");
	await joinShared(userId);
	await signIn(pb, "cara@t.dev");

	await pa.getByTestId("open-shared").click();
	await pb.getByTestId("open-shared").click();
	await expect(pa.getByTestId("new-task")).toBeVisible({ timeout: 15000 });
	await expect(pb.getByTestId("new-task")).toBeVisible({ timeout: 15000 });

	// --- Drag reorder ---
	for (const titleText of ["Alpha", "Beta"]) {
		await pa.getByTestId("new-task").fill(titleText);
		await pa.getByTestId("new-task-submit").click();
	}
	await expect(pb.getByText("Beta", { exact: true })).toBeVisible({
		timeout: 15000,
	});
	expect(await betaAboveAlpha(pa)).toBe(false);

	// Drag Alpha's grip handle down onto Beta. Intermediate pointer steps clear
	// the sensor's activation distance; only the dragged row's sortKey is written
	// and the synced-query re-sort drives the new order (design 2.8).
	const grip = await pa.getByTestId("task-drag").first().boundingBox();
	const beta = await pa.getByText("Beta", { exact: true }).boundingBox();
	if (!grip || !beta) throw new Error("missing drag targets");
	await pa.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
	await pa.mouse.down();
	await pa.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 12, {
		steps: 6,
	});
	await pa.mouse.move(beta.x + beta.width / 2, beta.y + beta.height * 0.75, {
		steps: 15,
	});
	await pa.mouse.move(beta.x + beta.width / 2, beta.y + beta.height * 0.95, {
		steps: 5,
	});
	await pa.mouse.up();

	await expect.poll(() => betaAboveAlpha(pa), { timeout: 15000 }).toBe(true);
	await expect.poll(() => betaAboveAlpha(pb), { timeout: 15000 }).toBe(true);

	// --- NLP quick-add (FAB is a mobile affordance) ---
	await pa.setViewportSize({ width: 375, height: 812 });
	await pa.getByLabel("Quick add").click();
	await pa.getByTestId("quickadd-input").fill("milk tomorrow p2 #store");
	await expect(pa.getByTestId("chip-date")).toBeVisible();
	await expect(pa.getByTestId("chip-priority")).toBeVisible();
	await expect(pa.getByTestId("chip-label")).toBeVisible();

	await pa.getByTestId("quickadd-submit").click();
	await pa.keyboard.press("Escape"); // sheet stays open for serial entry

	await expect(pa.getByText("milk", { exact: true })).toBeVisible({
		timeout: 15000,
	});
	await expect(pa.getByText("store", { exact: true })).toBeVisible();
	await expect(pa.getByLabel("Priority: Medium")).toBeVisible();

	// --- Mobile list-index reorder (same wiring, list.update sortKey) ---
	await pa.getByLabel("Back to lists").click();
	await pa.getByRole("button", { name: "New list" }).click();
	await pa.getByTestId("new-list").fill("Zeta");
	await pa.getByTestId("new-list-submit").click();
	await expect(pa.getByText("Zeta", { exact: true })).toBeVisible({
		timeout: 15000,
	});
	// The new list synced to the other client.
	await expect(pb.getByText("Zeta", { exact: true })).toBeVisible({
		timeout: 15000,
	});
	expect(await zetaAboveShared(pa)).toBe(false);

	// Keyboard reorder (a11y path): lift Shared list's grip, move below Zeta,
	// drop. Small waits let dnd-kit settle each step. Reliable across viewports
	// where pointer-drag emulation is finicky; same list.update sortKey path.
	await pa.getByTestId("list-drag").first().focus();
	await pa.keyboard.press("Space");
	await pa.waitForTimeout(150);
	await pa.keyboard.press("ArrowDown");
	await pa.waitForTimeout(150);
	await pa.keyboard.press("Space");

	await expect.poll(() => zetaAboveShared(pa), { timeout: 15000 }).toBe(true);
});

// --- Scenario 1: shopping starter renders category-grouped (phone viewport) ---
test("shopping list from starter renders category-grouped (mobile)", async ({
	browser,
}) => {
	const ctx = await browser.newContext({
		viewport: { width: 375, height: 812 },
	});
	const page = await ctx.newPage();
	await signUp(page, uniqueEmail("shop"));
	await waitWorkspaceReady(page);

	// Mobile create-list lives in a bottom sheet; pick the shopping starter.
	await page.getByRole("button", { name: "New list" }).click();
	await page.locator('[data-slot="select-trigger"]').nth(1).click();
	await page
		.getByRole("option", { name: "Shopping list", exact: true })
		.click();
	await page.getByTestId("new-list-submit").click();

	await page
		.getByRole("button", { name: "Shopping list", exact: true })
		.first()
		.click();
	const list = page.getByTestId("list");
	await expect(list.getByText("Milk", { exact: true })).toBeVisible({
		timeout: 15000,
	});
	// Category headers group the starter items (design 2.16 shopping kind).
	for (const category of ["Dairy", "Bakery", "Produce", "Meat", "Pantry"]) {
		await expect(list.getByText(category, { exact: true })).toBeVisible();
	}
	await ctx.close();
});

// --- Scenario 3: complete on A sinks + strikes and syncs to B ---
test("complete on A sinks + strikes and syncs to B", async ({ browser }) => {
	const email = uniqueEmail("sink");
	const a = await browser.newContext();
	const b = await browser.newContext();
	const pa = await a.newPage();
	const pb = await b.newPage();
	await signUp(pa, email);
	await signIn(pb, email); // same user, second device -> shares personal lists

	await createListDesktop(pa, "SinkList");
	await openListDesktop(pa, "SinkList");
	await addTask(pa, "Keep open");
	await addTask(pa, "Finish me");

	await openListDesktop(pb, "SinkList");
	const listA = pa.getByTestId("list");
	const listB = pb.getByTestId("list");
	await expect(listB.getByText("Finish me", { exact: true })).toBeVisible({
		timeout: 15000,
	});

	await listA.getByRole("checkbox", { name: "Finish me" }).check();
	// A: completed row is struck through and sinks below the open row.
	await expect(listA.getByText("Finish me", { exact: true })).toHaveClass(
		/line-through/,
	);
	await expect
		.poll(() => isAbove(listA, "Keep open", "Finish me"), { timeout: 15000 })
		.toBe(true);
	// B: same completed state within the sync budget.
	await expect(listB.getByRole("checkbox", { name: "Finish me" })).toBeChecked({
		timeout: 3000,
	});
	await a.close();
	await b.close();
});

// --- Scenario 5: subtask add + parent progress; no depth-2 affordance ---
test("subtask add + parent progress; depth-2 affordance absent", async ({
	browser,
}) => {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await signUp(page, uniqueEmail("sub"));

	await createListDesktop(page, "SubList");
	await openListDesktop(page, "SubList");
	await addTask(page, "Parent");
	const list = page.getByTestId("list");

	await list.getByRole("button", { name: "Parent", exact: true }).click();
	const detail = page.getByRole("dialog");
	for (const child of ["Child A", "Child B"]) {
		await detail.getByPlaceholder("Add subtask").fill(child);
		await detail.getByPlaceholder("Add subtask").press("Enter");
		await expect(detail.getByText(child, { exact: true })).toBeVisible();
	}
	await page.keyboard.press("Escape");
	await expect(detail).toBeHidden();

	// Parent row shows aggregate progress; completing one subtask advances it.
	await expect(list.getByText("0/2", { exact: true })).toBeVisible({
		timeout: 15000,
	});
	await list.getByRole("button", { name: "Expand subtasks" }).click();
	await list.getByRole("checkbox", { name: "Child A" }).check();
	await expect(list.getByText("1/2", { exact: true })).toBeVisible({
		timeout: 15000,
	});

	// A subtask's own detail offers no further nesting (subtasks are one level).
	await list.getByRole("button", { name: "Child A", exact: true }).click();
	const subDetail = page.getByRole("dialog");
	await expect(subDetail.getByLabel("Task title")).toBeVisible();
	await expect(subDetail.getByPlaceholder("Add subtask")).toHaveCount(0);
	await ctx.close();
});

// --- Scenario 6: save-as-template then create-from-template reproduces items ---
test("save list as template then create-from-template reproduces items", async ({
	browser,
}) => {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await signUp(page, uniqueEmail("tmpl"));

	const listName = `Recipe-${Date.now()}`;
	await createListDesktop(page, listName);
	await openListDesktop(page, listName);
	await addTask(page, "Flour");
	await addTask(page, "Sugar");

	await page.getByRole("button", { name: "List display options" }).click();
	await page.getByTestId("save-as-template").click();

	await backToIndexDesktop(page);
	await page.locator('[data-slot="select-trigger"]').nth(1).click();
	await page.getByRole("option", { name: listName, exact: true }).click();
	await page.getByTestId("new-list-submit").click();

	// The workspace now holds the source list and its template-spawned copy.
	await expect(
		sidebarLists(page).getByRole("button", { name: listName, exact: true }),
	).toHaveCount(2, { timeout: 15000 });
	await openListDesktop(page, listName); // opens the newest (copy)
	const list = page.getByTestId("list");
	await expect(list.getByText("Flour", { exact: true })).toBeVisible({
		timeout: 15000,
	});
	await expect(list.getByText("Sugar", { exact: true })).toBeVisible();
	await ctx.close();
});

// --- Scenario 7: isolation regression across list/folder/label tables ---
async function personalWorkspaceId(userId: string): Promise<string> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		const rows = await pool.query<{ id: string }>(
			"select id from workspace where owner_id = $1 and kind = 'personal'",
			[userId],
		);
		const id = rows.rows[0]?.id;
		if (!id) throw new Error("personal workspace not found");
		return id;
	} finally {
		await pool.end();
	}
}

async function insertFolderAndLabel(
	workspaceId: string,
	folderName: string,
	labelName: string,
): Promise<void> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await pool.query(
			"insert into folder (id, workspace_id, name, sort_key) values ($1, $2, $3, 'a0')",
			[crypto.randomUUID(), workspaceId, folderName],
		);
		await pool.query(
			"insert into label (id, workspace_id, name, color) values ($1, $2, $3, 'gray')",
			[crypto.randomUUID(), workspaceId, labelName],
		);
	} finally {
		await pool.end();
	}
}

test("isolation: B never sees A's personal list, folder, or label", async ({
	browser,
}) => {
	const a = await browser.newContext();
	const b = await browser.newContext();
	const pa = await a.newPage();
	const pb = await b.newPage();
	const aId = await signUp(pa, uniqueEmail("iso-a"));
	const bId = await signUp(pb, uniqueEmail("iso-b"));
	await joinShared(aId);
	await joinShared(bId);

	const stamp = Date.now();
	const listName = `ASecretList-${stamp}`;
	const folderName = `ASecretFolder-${stamp}`;
	const labelName = `ASecretLabel-${stamp}`;
	const aWs = await personalWorkspaceId(aId);
	await insertFolderAndLabel(aWs, folderName, labelName);

	// A puts its list inside the folder, so the folder header renders for A.
	await reloadToIndex(pa);
	await pa.getByTestId("new-list").fill(listName);
	await pa.locator('[data-slot="select-trigger"]').first().click();
	await pa.getByRole("option", { name: folderName, exact: true }).click();
	await pa.getByTestId("new-list-submit").click();
	// Control: A sees its own folder header + list (scoped to the sidebar so the
	// folder-select's retained value doesn't double-match).
	await expect(
		sidebarLists(pa).getByText(folderName, { exact: true }),
	).toBeVisible({ timeout: 15000 });
	await expect(
		sidebarLists(pa).getByRole("button", { name: listName, exact: true }),
	).toBeVisible();

	// Both live in the shared workspace so B's client is subscribed and settled.
	await pa.getByTestId("open-shared").click();
	await pb.getByTestId("open-shared").click();
	await expect(pb.getByTestId("new-task")).toBeVisible({ timeout: 15000 });

	// B's synced queries never leak A's personal list/folder/label rows.
	await expect(pb.getByText(listName)).toHaveCount(0);
	await expect(pb.getByText(folderName)).toHaveCount(0);
	await expect(pb.getByText(labelName)).toHaveCount(0);
	await a.close();
	await b.close();
});

// A's folder is inserted after signup, so reload to let its folders query pick
// it up before it is selected in the create-list form.
async function reloadToIndex(page: Page): Promise<void> {
	await page.reload();
	await expect(page.getByTestId("new-list")).toBeVisible({ timeout: 15000 });
	await waitWorkspaceReady(page);
}

// --- Step 2: axe on the four merge-gate surfaces ---
test("a11y: no serious/critical violations on core surfaces", async ({
	browser,
}) => {
	test.setTimeout(120000);
	const email = uniqueEmail("axe");
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await signUp(page, email);

	await expect(page.getByTestId("new-list")).toBeVisible();
	await expectNoSeriousA11y(page, "workspace index");

	const kinds: [string, string | undefined][] = [
		["Tasks board", undefined],
		["Project board", "Project"],
		["Shopping board", "Shopping"],
		["Checklist board", "Checklist"],
	];
	for (const [name, kindLabel] of kinds) {
		await createListDesktop(page, name, kindLabel);
	}
	for (const [name] of kinds) {
		await openListDesktop(page, name);
		await addTask(page, `${name} item`);
		await expectNoSeriousA11y(page, `list view (${name})`);
	}

	await openListDesktop(page, "Tasks board");
	await page
		.getByTestId("list")
		.getByRole("button", { name: "Tasks board item", exact: true })
		.click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expectNoSeriousA11y(page, "task detail");
	await page.keyboard.press("Escape");
	await ctx.close();

	// Quick-add sheet is a mobile (FAB) affordance.
	const mctx = await browser.newContext({
		viewport: { width: 375, height: 812 },
	});
	const mp = await mctx.newPage();
	await signIn(mp, email);
	await mp.getByLabel("Quick add").click();
	await expect(mp.getByTestId("quickadd-input")).toBeVisible();
	await expectNoSeriousA11y(mp, "quick-add sheet");
	await mctx.close();
});
