import { expect, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import {
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

// Zero 1.11 runs in memory when its IndexedDB database cannot open. The sync
// indicator must stop claiming on-device saving, and offline edits must be
// refused instead of living only in memory.

async function serverHasTask(title: string): Promise<boolean> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		const { rowCount } = await pool.query(
			"select 1 from task where title = $1",
			[title],
		);
		return (rowCount ?? 0) > 0;
	} finally {
		await pool.end();
	}
}

async function addTask(page: Page, title: string) {
	await page.getByTestId("new-task").fill(title);
	await page.getByTestId("new-task-submit").click();
}

test("desktop: a local storage failure is shown and offline edits are refused", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	await page.addInitScript(() => {
		const open = IDBFactory.prototype.open;
		IDBFactory.prototype.open = function (name: string, version?: number) {
			if (!name.startsWith("rep:zero-")) return open.call(this, name, version);
			const request = {} as IDBOpenDBRequest & { error: DOMException };
			setTimeout(() => {
				Object.defineProperty(request, "error", {
					value: new DOMException("Injected storage failure", "UnknownError"),
				});
				request.onerror?.(new Event("error"));
			});
			return request;
		};
	});
	await signUp(page, uniqueEmail("storage-failure"));
	await waitWorkspaceReady(page);
	const list = `Storage ${crypto.randomUUID().slice(0, 8)}`;
	await page.getByTestId("sidebar-create").click();
	await page.getByTestId("sidebar-new-list").click();
	await page.getByTestId("new-list").fill(list);
	await page.getByTestId("new-list-submit").click();
	await sidebarLists(page)
		.getByRole("button", { name: list, exact: true })
		.last()
		.click();
	await expect(page.getByTestId("list")).toBeVisible();

	const indicator = page.getByTestId("sync-indicator");
	await expect(indicator).toHaveAttribute("data-phase", "storage-failed");
	await indicator.click();
	await expect(page.getByTestId("sync-popover")).toContainText(
		"An edit is kept only once it reaches the server",
	);
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("sync-popover")).toHaveCount(0);

	const online = `Reaches server ${crypto.randomUUID()}`;
	await addTask(page, online);
	await expect.poll(() => serverHasTask(online)).toBe(true);

	await context.setOffline(true);
	await expect(indicator).toHaveAttribute("data-phase", "storage-offline", {
		timeout: 20_000,
	});
	const refused = `Memory only ${crypto.randomUUID()}`;
	await addTask(page, refused);
	await expect(
		page.getByRole("alert").filter({ hasText: "this change wasn't saved" }),
	).toBeVisible();
	await expect(
		page.getByTestId("list").getByText(refused, { exact: true }),
	).toHaveCount(0);

	await context.setOffline(false);
	await expect(indicator).toHaveAttribute("data-phase", "storage-failed", {
		timeout: 30_000,
	});
	expect(await serverHasTask(refused)).toBe(false);
});
