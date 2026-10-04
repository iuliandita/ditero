import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import {
	goToSettings,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

test.describe.configure({ timeout: 90_000 });
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
	let failure: unknown;
	try {
		const ownerPage = await ownerContext.newPage();
		const ownerId = await signUp(ownerPage, uniqueEmail("calendar-feed-owner"));
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
			[crypto.randomUUID(), listId],
		);
		await page.reload();
		await waitWorkspaceReady(page);
		await goToSettings(page);
		const panel = page.getByTestId("calendar-feeds");
		const dialog = await openCreate(page, "Viewer calendar", listId);
		await dialog
			.getByRole("button", { name: "Create subscription", exact: true })
			.click();
		const urlInput = dialog.getByTestId("calendar-feed-url");
		await expect(urlInput).toBeVisible();
		const url = await urlInput.inputValue();
		expect(new URL(url).origin).toBe(new URL(page.url()).origin);
		const download = await page.request.get(url);
		expect(download.status()).toBe(200);
		expect(await download.text()).toContain("Calendar visible task");
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
		const { violations } = await new AxeBuilder({ page })
			.include('[data-testid="calendar-feed-dialog"]')
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
		await panel
			.getByRole("button", { name: 'Revoke "Viewer calendar"?', exact: true })
			.click();
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
		await departedDialog
			.getByRole("button", { name: "Done", exact: true })
			.click();
		await expect(departedDialog).toHaveCount(0);
		await expect(page.getByTestId("calendar-feed-url")).toHaveCount(0);

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
				name: 'Revoke "Departed Viewer calendar"?',
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
	const errors: unknown[] = [];
	for (const cleanup of [
		() => pool.query(`delete from workspace where id=$1`, [workspaceId]),
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
});

test("calendar subscriptions: closing a pending creation discards its late URL; uncertain POST is not retried", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await signUp(page, uniqueEmail("calendar-feed-cancel"));
	await goToSettings(page);
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
		await dialog
			.getByRole("button", { name: "Create subscription", exact: true })
			.click();
		await expect.poll(() => held).toBe(1);
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		release?.();
		await expect.poll(() => completed).toBe(1);
		await expect(page.getByTestId("calendar-feeds")).toContainText(
			"Creation was not confirmed",
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
