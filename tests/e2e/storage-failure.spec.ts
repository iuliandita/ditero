import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { Pool } from "pg";
import {
	goToSettings,
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

import { installPersistenceControls } from "./zero-persistence-controls.ts";

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

// Exercise the app-owned client, not a parallel test client. Retiring must not
// stop its socket before the accepted queue has a durable server copy.
async function attemptRetirement(page: Page) {
	return page.evaluate(async () => {
		const lifecycle = window.__diteroZeroLifecycle;
		if (!lifecycle) throw new Error("E2E retirement hook is unavailable");
		try {
			await lifecycle.retireZeroClients();
			return { retired: true, message: "" };
		} catch (error) {
			return {
				retired: false,
				message: lifecycle.retirementErrorMessage(error),
			};
		}
	});
}

for (const discoverDuringClose of [false, true]) {
	test(`desktop: post-open quota failure keeps accepted edits syncing (during close: ${discoverDuringClose})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await page.addInitScript(installPersistenceControls);
		await signUp(page, uniqueEmail("storage-quota"));
		await openStorageList(page);
		const indicator = page.getByTestId("sync-indicator");
		await expect(indicator).toHaveAttribute("data-phase", "synced");
		const control = `Persisted control ${crypto.randomUUID()}`;
		await page.evaluate((marker) => {
			window.__zeroCloseControls.marker = marker;
		}, control);
		await addTask(page, control);
		await expect.poll(() => serverHasTask(control)).toBe(true);
		await expect
			.poll(() =>
				page.evaluate(() => window.__zeroCloseControls.completedTransactions),
			)
			.toBeGreaterThan(0);
		await context.setOffline(true);
		await expect(indicator).toHaveAttribute("data-phase", "offline", {
			timeout: 20_000,
		});
		const queued = `Accepted before quota ${crypto.randomUUID()}`;
		await page.evaluate(
			({ marker, hold }) => {
				const c = window.__zeroCloseControls;
				c.marker = marker;
				c.mode = "fail";
				c.failure = new DOMException(
					"Injected quota after successful open",
					"QuotaExceededError",
				);
				c.idleHeld = hold;
				c.puts = 0;
			},
			{ marker: queued, hold: discoverDuringClose },
		);
		await addTask(page, queued);
		await expect(
			page.getByTestId("list").getByText(queued, { exact: true }),
		).toBeVisible();
		expect(await serverHasTask(queued)).toBe(false);
		if (!discoverDuringClose) {
			await expect(indicator).toHaveAttribute("data-phase", "storage-offline", {
				timeout: 20_000,
			});
		}
		const blocked = await attemptRetirement(page);
		expect(blocked.retired).toBe(false);
		expect(blocked.message).toMatch(/Unsynced edits: [1-9]/);
		await expect(indicator).toHaveAttribute("data-phase", "storage-offline");
		expect(
			await page.evaluate(() => window.__zeroCloseControls.puts),
		).toBeGreaterThan(0);
		await context.setOffline(false);
		await expect
			.poll(() => serverHasTask(queued), { timeout: 30_000 })
			.toBe(true);
		await expect(indicator).toHaveAttribute("data-phase", "storage-failed");
		// The server row can land before this client's ack; a refused retirement
		// stays retryable, so retry until the queue is acknowledged.
		await expect
			.poll(() => attemptRetirement(page), { timeout: 20_000 })
			.toMatchObject({ retired: true });
		await page.evaluate(() => window.__zeroCloseControls.restore());
	});
}

async function openStorageList(page: Page) {
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
}

test("desktop: memory fallback retirement waits for server acknowledgement", async ({
	page,
}) => {
	test.setTimeout(90_000);
	let holding = false;
	const held: { server: WebSocketRoute; message: string | Buffer }[] = [];
	await page.routeWebSocket(/\/sync\/v\d+\/connect/, (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			const data: unknown = JSON.parse(message.toString());
			if (holding && Array.isArray(data) && data[0] === "push")
				held.push({ server, message });
			else server.send(message);
		});
	});
	await page.addInitScript(() => {
		const open = IDBFactory.prototype.open;
		IDBFactory.prototype.open = function (name, version) {
			if (!name.startsWith("rep:zero-")) return open.call(this, name, version);
			const request = {} as IDBOpenDBRequest;
			setTimeout(() => {
				Object.defineProperty(request, "error", {
					value: new DOMException("Injected open failure", "UnknownError"),
				});
				request.onerror?.(new Event("error"));
			});
			return request;
		};
	});
	await signUp(page, uniqueEmail("memory-retirement"));
	await openStorageList(page);
	const indicator = page.getByTestId("sync-indicator");
	await expect(indicator).toHaveAttribute("data-phase", "storage-failed");
	const control = `Memory control ${crypto.randomUUID()}`;
	await addTask(page, control);
	await expect.poll(() => serverHasTask(control)).toBe(true);
	holding = true;
	const queued = `Memory pending ${crypto.randomUUID()}`;
	await addTask(page, queued);
	await expect(
		page.getByTestId("list").getByText(queued, { exact: true }),
	).toBeVisible();
	await expect.poll(() => held.length).toBeGreaterThan(0);
	expect(await serverHasTask(queued)).toBe(false);
	await goToSettings(page);
	await page.getByTestId("sign-out").click();
	await expect(
		page.getByRole("alert").filter({ hasText: /Unsynced edits: [1-9]/ }),
	).toBeVisible();
	await expect(page.getByTestId("settings-account-email")).toBeVisible();
	await expect(indicator).toHaveAttribute("data-phase", "storage-failed");
	holding = false;
	for (const { server, message } of held.splice(0)) server.send(message);
	await expect
		.poll(() => serverHasTask(queued), { timeout: 30_000 })
		.toBe(true);
	await page.getByTestId("sign-out").click();
	await expect(page.getByTestId("signin")).toBeVisible();
});
