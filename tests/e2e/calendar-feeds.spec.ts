import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import {
	goToSettings,
	openMobileLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

test.describe.configure({ timeout: 90_000 });
// Emulated touch context: geometry checks below only prove coarse-pointer sizing, not real gestures.
test.use({ hasTouch: true });

type CleanupClient = {
	query(sql: string, params?: unknown[]): Promise<unknown>;
	release(destroy?: boolean): void;
};
type CleanupPool = {
	connect(): Promise<CleanupClient>;
	end(): Promise<void>;
};
type CleanupContext = { close(): Promise<void> };
type CleanupIds = {
	workspaceId: string;
	listId: string;
	taskId: string;
	ownerId: string | undefined;
	actorId: string;
};

// calendar-cleanup:begin
async function deleteFixtureRows(pool: CleanupPool, ids: CleanupIds) {
	// Without an owner id nothing was inserted for this fixture.
	if (!ids.ownerId) return;
	const client = await pool.connect();
	let rollbackFailed = false;
	try {
		await client.query("begin");
		await client.query(`delete from task where id=$1 and list_id=$2`, [
			ids.taskId,
			ids.listId,
		]);
		await client.query(`delete from list where id=$1 and workspace_id=$2`, [
			ids.listId,
			ids.workspaceId,
		]);
		for (const userId of [ids.actorId, ids.ownerId])
			await client.query(
				`delete from membership where workspace_id=$1 and user_id=$2`,
				[ids.workspaceId, userId],
			);
		await client.query(`delete from workspace where id=$1`, [ids.workspaceId]);
		await client.query("commit");
	} catch (error) {
		try {
			await client.query("rollback");
		} catch (rollbackError) {
			rollbackFailed = true;
			throw new AggregateError(
				[error, rollbackError],
				"Calendar fixture cleanup rollback failed",
				{ cause: error },
			);
		}
		throw error;
	} finally {
		client.release(rollbackFailed);
	}
}

async function runFixtureCleanup(
	failure: unknown,
	pool: CleanupPool,
	ownerContext: CleanupContext,
	ids: CleanupIds,
) {
	const errors: unknown[] = [];
	for (const cleanup of [
		() => deleteFixtureRows(pool, ids),
		() => pool.end(),
		() => ownerContext.close(),
	]) {
		try {
			await cleanup();
		} catch (error) {
			errors.push(error);
		}
	}
	if (failure || errors.length)
		throw new AggregateError(
			[...(failure ? [failure] : []), ...errors],
			"Calendar browser fixture failed",
			{ cause: failure ?? errors[0] },
		);
}
// calendar-cleanup:end

async function expectCoarsePointer(page: Page) {
	expect(
		await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches),
	).toBe(true);
}

async function expectTouchTarget(target: Locator, label: string) {
	await expect(target, label).toBeVisible();
	const box = await target.boundingBox();
	if (!box) throw new Error(`Missing bounds for ${label}`);
	expect(box.height, `${label} height`).toBeGreaterThanOrEqual(44);
	expect(box.width, `${label} width`).toBeGreaterThanOrEqual(44);
}

async function openCreate(page: Page, name: string, listId?: string) {
	const panel = page.getByTestId("calendar-feeds");
	await panel
		.getByRole("button", { name: "Create subscription", exact: true })
		.click();
	const dialog = page.getByTestId("calendar-feed-dialog");
	await dialog.getByLabel("Subscription name", { exact: true }).fill(name);
	const select = dialog.getByLabel("List", { exact: true });
	if (listId) await select.selectOption(listId);
	else {
		await expect(select.locator("option")).not.toHaveCount(1);
		const id = await select.locator("option").nth(1).getAttribute("value");
		if (!id) throw new Error("Missing synced list choice");
		await select.selectOption(id);
	}
	await expect(dialog.getByLabel("Expires after (days)")).toHaveValue("90");
	return dialog;
}

test("calendar subscriptions: Viewer creates a bound URL once and revocation stops real downloads", async ({
	page,
	browser,
}) => {
	const actorId = await signUp(page, uniqueEmail("calendar-feed-viewer"));
	const ownerContext = await browser.newContext();
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	const workspaceId = crypto.randomUUID();
	const listId = crypto.randomUUID();
	const taskId = crypto.randomUUID();
	let ownerId: string | undefined;
	let failure: unknown;
	try {
		const ownerPage = await ownerContext.newPage();
		ownerId = await signUp(ownerPage, uniqueEmail("calendar-feed-owner"));
		await pool.query(
			`insert into workspace (id,name,kind,owner_id) values ($1,'Calendar shared space','shared',$2)`,
			[workspaceId, ownerId],
		);
		await pool.query(
			`insert into membership (id,workspace_id,user_id,role) values ($1,$2,$3,'owner'),($4,$2,$5,'viewer')`,
			[crypto.randomUUID(), workspaceId, ownerId, crypto.randomUUID(), actorId],
		);
		await pool.query(
			`insert into list (id,workspace_id,owner_id,title,kind,sort_key) values ($1,$2,$3,'Calendar viewer list','tasks','a0')`,
			[listId, workspaceId, ownerId],
		);
		await pool.query(
			`insert into task (id,list_id,title,sort_key,due_at) values ($1,$2,'Calendar visible task','a0',now())`,
			[taskId, listId],
		);
		await page.reload();
		await waitWorkspaceReady(page);
		await goToSettings(page);
		const panel = page.getByTestId("calendar-feeds");
		await expectCoarsePointer(page);
		await expectTouchTarget(
			panel.getByRole("button", { name: "Create subscription", exact: true }),
			"page Create subscription",
		);
		const dialog = await openCreate(page, "Viewer calendar", listId);
		const dialogCreate = dialog.getByRole("button", {
			name: "Create subscription",
			exact: true,
		});
		await expectTouchTarget(dialogCreate, "dialog Create subscription");
		await dialogCreate.click();
		const urlInput = dialog.getByTestId("calendar-feed-url");
		await expect(urlInput).toBeVisible();
		const url = await urlInput.inputValue();
		expect(new URL(url).origin).toBe(new URL(page.url()).origin);
		const download = await page.request.get(url);
		expect(download.status()).toBe(200);
		expect(await download.text()).toContain("Calendar visible task");
		// A real pointer press on the scrim must not discard the one-time URL.
		const dialogBox = await dialog.boundingBox();
		if (!dialogBox) throw new Error("Missing calendar dialog bounds");
		const outside = { x: 4, y: 4 };
		expect(
			outside.x < dialogBox.x ||
				outside.x > dialogBox.x + dialogBox.width ||
				outside.y < dialogBox.y ||
				outside.y > dialogBox.y + dialogBox.height,
		).toBe(true);
		await page.mouse.click(outside.x, outside.y);
		await expect(dialog).toBeVisible();
		await expect(urlInput).toBeVisible();
		await expect(urlInput).toHaveValue(url);
		await expectTouchTarget(
			dialog.getByRole("button", { name: "Copy", exact: true }),
			"dialog Copy",
		);
		await expectTouchTarget(
			dialog.getByRole("button", { name: "Done", exact: true }),
			"dialog Done",
		);
		await page.evaluate(() => {
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: {
					writeText: async (value: string) => {
						Reflect.set(window, "calendarCopied", value);
					},
				},
			});
		});
		await dialog.getByRole("button", { name: "Copy", exact: true }).click();
		await expect(dialog.getByRole("status")).toContainText("Copied");
		expect(
			await page.evaluate(() => Reflect.get(window, "calendarCopied")),
		).toBe(url);
		await page.evaluate(() => {
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: {
					writeText: async () => {
						throw new Error("Denied");
					},
				},
			});
			document.execCommand = () => false;
		});
		await dialog.getByRole("button", { name: "Copy", exact: true }).click();
		await expect(dialog.getByRole("status")).toContainText("Copy failed");
		// The dialog is same-origin with no iframes, so legacy mode (axe.run in
		// the page) skips the per-frame runPartial/finishRun blank-page handoff.
		const { violations } = await new AxeBuilder({ page })
			.include('[data-testid="calendar-feed-dialog"]')
			.setLegacyMode(true)
			.analyze();
		expect(
			violations.filter(
				(row) => row.impact === "serious" || row.impact === "critical",
			),
		).toEqual([]);
		await dialog.getByRole("button", { name: "Done", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(page.getByTestId("calendar-feed-url")).toHaveCount(0);
		expect((await page.request.get(url)).status()).toBe(200);
		const revokeViewer = panel.getByRole("button", {
			name: "Revoke Viewer calendar",
			exact: true,
		});
		await expectTouchTarget(revokeViewer, "Revoke Viewer calendar");
		await revokeViewer.click();
		await page.getByTestId("confirm-accept").click();
		await expect(
			panel
				.getByRole("listitem")
				.filter({ has: page.getByText("Viewer calendar", { exact: true }) }),
		).toContainText("Revoked");
		expect((await page.request.get(url)).status()).toBe(404);
		const membership = await pool.query(
			`select role from membership where workspace_id=$1 and user_id=$2`,
			[workspaceId, actorId],
		);
		expect(membership.rows).toEqual([{ role: "viewer" }]);

		const departedDialog = await openCreate(
			page,
			"Departed Viewer calendar",
			listId,
		);
		await departedDialog
			.getByRole("button", { name: "Create subscription", exact: true })
			.click();
		const departedInput = departedDialog.getByTestId("calendar-feed-url");
		await expect(departedInput).toBeVisible();
		const departedUrl = await departedInput.inputValue();
		expect((await page.request.get(departedUrl)).status()).toBe(200);
		await page.keyboard.press("Escape");
		await expect(departedDialog).toHaveCount(0);
		await expect(page.getByTestId("calendar-feed-url")).toHaveCount(0);
		expect((await page.request.get(departedUrl)).status()).toBe(200);

		// Losing membership hides the source, but account-owned metadata and revoke remain.
		await pool.query(
			`delete from membership where workspace_id=$1 and user_id=$2`,
			[workspaceId, actorId],
		);
		expect((await page.request.get(departedUrl)).status()).toBe(404);
		await page.reload();
		await waitWorkspaceReady(page);
		await goToSettings(page);
		const departedRow = panel.getByRole("listitem").filter({
			has: page.getByText("Departed Viewer calendar", { exact: true }),
		});
		await expect(departedRow).toContainText("List unavailable");
		await panel
			.getByRole("button", {
				name: "Revoke Departed Viewer calendar",
				exact: true,
			})
			.click();
		await page.getByTestId("confirm-accept").click();
		await expect(departedRow).toContainText("Revoked");
		expect((await page.request.get(departedUrl)).status()).toBe(404);
		const metadata = await page.request.get("/api/calendar-feeds");
		const body = await metadata.json();
		for (const name of ["Viewer calendar", "Departed Viewer calendar"])
			expect(
				body.data.some(
					(row: { name: string; revokedAt: string | null }) =>
						row.name === name && row.revokedAt !== null,
				),
			).toBe(true);
		for (const feedUrl of [url, departedUrl])
			expect(JSON.stringify(body)).not.toContain(
				new URL(feedUrl).pathname.split("/")[4],
			);
	} catch (error) {
		failure = error;
	}
	await runFixtureCleanup(failure, pool, ownerContext, {
		workspaceId,
		listId,
		taskId,
		ownerId,
		actorId,
	});
});

test("calendar subscriptions: closing a pending creation discards its late URL; uncertain POST is not retried", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await signUp(page, uniqueEmail("calendar-feed-cancel"));
	await waitWorkspaceReady(page);
	await openMobileLists(page);
	await page.getByRole("button", { name: "New list", exact: true }).click();
	await page.getByTestId("new-list").fill("Calendar pending list");
	await page.getByTestId("new-list-submit").click();
	await expect(page.getByTestId("new-list-submit")).toHaveCount(0);
	await expect(
		page
			.getByRole("button", { name: "Calendar pending list", exact: true })
			.first(),
	).toBeVisible();
	await goToSettings(page);
	await expectCoarsePointer(page);
	let release: (() => void) | undefined;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	let posts = 0;
	let held = 0;
	let completed = 0;
	await page.route("**/api/calendar-feeds", async (route) => {
		if (route.request().method() !== "POST") {
			await route.continue();
			return;
		}
		posts++;
		if (posts === 1) {
			const response = await route.fetch();
			expect(response.status()).toBe(201);
			held++;
			await barrier;
			await route.fulfill({ response });
			completed++;
		} else await route.abort("failed");
	});
	try {
		const dialog = await openCreate(page, "Pending calendar");
		const pendingCreate = dialog.getByRole("button", {
			name: "Create subscription",
			exact: true,
		});
		await expectTouchTarget(pendingCreate, "mobile dialog Create subscription");
		await pendingCreate.click();
		await expect.poll(() => held).toBe(1);
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		release?.();
		await expect.poll(() => completed).toBe(1);
		await expect(page.getByTestId("calendar-feeds")).toContainText(
			"Creation was not confirmed",
		);
		await expectTouchTarget(
			page
				.getByTestId("calendar-feeds")
				.getByRole("button", { name: "Try again", exact: true }),
			"Try again",
		);
		await expect(page.getByTestId("calendar-feed-url")).toHaveCount(0);
		const next = await openCreate(page, "Uncertain calendar");
		await next
			.getByRole("button", { name: "Create subscription", exact: true })
			.click();
		await expect(next.getByRole("alert")).toContainText(
			"Creation was not confirmed",
		);
		await expect(
			next.getByRole("button", { name: "Create subscription", exact: true }),
		).toBeDisabled();
		expect(posts).toBe(2);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);
	} finally {
		release?.();
		await page.unroute("**/api/calendar-feeds");
	}
});
