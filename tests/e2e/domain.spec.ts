import { expect, type Page, test } from "@playwright/test";
import { Pool } from "pg";

// Task 10 cluster: NLP quick-add and drag reorder. Task 11 extends this file
// with the rest of the domain matrix (kinds, templates, a11y, isolation).
//
// One signup + one sign-in of the SAME user across two contexts keeps the suite
// under Better Auth's per-IP signup rate limit (5/60s) while still exercising
// live cross-client sync in the shared workspace.

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
