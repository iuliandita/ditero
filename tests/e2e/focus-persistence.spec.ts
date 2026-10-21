import { expect, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import {
	goToSettings,
	leaveSettings,
	openDetails,
	openMoreOptions,
	signUp,
	uniqueEmail,
} from "./helpers.ts";
import { installPersistenceControls } from "./zero-persistence-controls.ts";

type FocusState = import("../../src/web/focus/timer-persistence.ts").FocusState;

test.describe.configure({ timeout: 90000 });
async function startTask(page: Page, seconds: number) {
	await page.addInitScript((sec) => {
		(window as { __diteroFocusTestSec?: number }).__diteroFocusTestSec = sec;
	}, seconds);
	const userId = await signUp(page, uniqueEmail("persist-focus"));
	await goToSettings(page);
	await page.getByTestId("focus-autocycle").click();
	await expect(page.getByTestId("focus-autocycle")).toHaveAttribute(
		"aria-checked",
		"false",
	);
	await leaveSettings(page);
	await page.getByTestId("create-list-open").click();
	await page.getByTestId("new-list").fill("Timer tasks");
	await page.getByTestId("new-list-submit").click();
	await page
		.locator('nav[aria-label="Lists"]')
		.getByRole("button", { name: "Timer tasks", exact: true })
		.click();
	await page.getByTestId("new-task").fill("Read together");
	await page.getByTestId("new-task-submit").click();
	await openDetails(page, "Read together");
	const detail = page.getByRole("dialog");
	await openMoreOptions(detail);
	await detail.getByTestId("task-focus-start").click();
	await detail.getByRole("button", { name: "Close", exact: true }).click();
	await expect(detail).toHaveCount(0);
	await expect(
		page.getByTestId("focus-timer").getByTestId("focus-pause"),
	).toBeVisible();
	return userId;
}

test("running and paused task timers survive reload; Stop discards them", async ({
	page,
}) => {
	await startTask(page, 120);
	const timer = page.getByTestId("focus-timer");
	await expect(timer.getByTestId("focus-pause")).toBeVisible();
	await page.reload();
	await expect(timer.getByTestId("focus-task")).toHaveText("Read together");
	await expect(timer.getByTestId("focus-pause")).toBeVisible();
	await timer.getByTestId("focus-pause").click();
	await expect(timer.getByTestId("focus-start")).toBeVisible();
	const paused = await timer.getByTestId("focus-countdown").textContent();
	await page.reload();
	await expect(timer.getByTestId("focus-start")).toBeVisible();
	await expect(timer.getByTestId("focus-countdown")).toHaveText(paused ?? "");
	await timer.getByTestId("focus-start").click();
	await expect(timer.getByTestId("focus-pause")).toBeVisible();
	await timer.getByTestId("focus-stop").click();
	await expect(timer).toHaveCount(0);
	await page.reload();
	await expect(page.getByTestId("workspace")).toBeVisible();
	await expect(timer).toHaveCount(0);
});

test("an online interval reloaded mid-way is still logged once", async ({
	page,
}) => {
	const userId = await startTask(page, 8);
	await serverStartObserved(page, userId);
	await page.reload();
	const timer = page.getByTestId("focus-timer");
	await expect(timer.getByTestId("focus-task")).toHaveText("Read together");
	await expect(timer.getByTestId("focus-phase")).toHaveText("Break", {
		timeout: 20000,
	});
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await expect
			.poll(
				async () =>
					(
						await pool.query(
							"select duration_sec from focus_session where user_id=$1 and task_id is not null",
							[userId],
						)
					).rows,
			)
			.toEqual([{ duration_sec: 8 }]);
		await page.reload();
		await expect(timer.getByTestId("focus-phase")).toHaveText("Break");
		await expect
			.poll(async () => (await focusState(page, userId)).pendingCompletions)
			.toEqual([]);
		expect(
			(
				await pool.query(
					"select count(*)::int as count from focus_session where user_id=$1",
					[userId],
				)
			).rows,
		).toEqual([{ count: 1 }]);
	} finally {
		await pool.end();
	}
});

test("a start acknowledgement lost before a reload is recovered from the synced start", async ({
	page,
}) => {
	const userId = await startTask(page, 15);
	await serverStartObserved(page, userId);
	await forgetServerStart(page, userId);
	await page.reload();
	const timer = page.getByTestId("focus-timer");
	await expect(timer.getByTestId("focus-task")).toHaveText("Read together");
	await expect
		.poll(async () => (await focusState(page, userId)).session?.serverStarted)
		.toBe(true);
	await expect(timer.getByTestId("focus-phase")).toHaveText("Break", {
		timeout: 30000,
	});
	await expect(page.getByTestId("focus-error")).toHaveCount(0);
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await expect
			.poll(
				async () =>
					(
						await pool.query(
							"select duration_sec from focus_session where user_id=$1",
							[userId],
						)
					).rows,
			)
			.toEqual([{ duration_sec: 15 }]);
	} finally {
		await pool.end();
	}
});

test("an interval with no recorded start and no monotonic proof is reported as not counted", async ({
	page,
}) => {
	const userId = await startTask(page, 15);
	await serverStartObserved(page, userId);
	await forgetServerStart(page, userId);
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await pool.query("delete from focus_interval_start where user_id=$1", [
			userId,
		]);
		await page.reload();
		const timer = page.getByTestId("focus-timer");
		await expect(timer.getByTestId("focus-phase")).toHaveText("Break", {
			timeout: 40000,
		});
		await expect(page.getByTestId("focus-error")).toContainText(
			"wasn't counted",
		);
		expect(
			(
				await pool.query(
					"select count(*)::int as count from focus_session where user_id=$1",
					[userId],
				)
			).rows,
		).toEqual([{ count: 0 }]);
	} finally {
		await pool.end();
	}
});

test("an interval that expires away records once and parks on the next phase", async ({
	page,
}) => {
	const userId = await startTask(page, 5);
	await serverStartObserved(page, userId);
	const origin = page.url();
	const expiredAt = Date.now() + 6000;
	await page.goto("about:blank");
	await expect
		.poll(Date.now, { timeout: 10000 })
		.toBeGreaterThanOrEqual(expiredAt);
	await page.goto(origin);
	const timer = page.getByTestId("focus-timer");
	await expect(timer.getByTestId("focus-phase")).toHaveText("Break");
	await expect(timer.getByTestId("focus-start")).toBeVisible();
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await expect
			.poll(
				async () =>
					(
						await pool.query(
							"select duration_sec from focus_session where user_id=$1 and task_id is not null",
							[userId],
						)
					).rows,
			)
			.toEqual([{ duration_sec: 5 }]);
		await page.reload();
		await expect(timer.getByTestId("focus-phase")).toHaveText("Break");
		expect(
			(
				await pool.query(
					"select count(*)::int as count from focus_session where user_id=$1",
					[userId],
				)
			).rows,
		).toEqual([{ count: 1 }]);
	} finally {
		await pool.end();
	}
});

async function focusState(page: Page, userId: string) {
	return page.evaluate(async (userId) => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("ditero-focus", 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			return await new Promise<FocusState>((resolve, reject) => {
				const request = db
					.transaction("timers")
					.objectStore("timers")
					.get(`ditero:focus:${JSON.stringify(["browser", userId])}`);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		} finally {
			db.close();
		}
	}, userId);
}

// Leaves the persisted timer as if the start acknowledgement never arrived.
async function forgetServerStart(page: Page, userId: string) {
	await page.evaluate(async (userId) => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("ditero-focus", 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			await new Promise<void>((resolve, reject) => {
				const transaction = db.transaction("timers", "readwrite");
				const store = transaction.objectStore("timers");
				const key = `ditero:focus:${JSON.stringify(["browser", userId])}`;
				const request = store.get(key);
				request.onsuccess = () => {
					const state = request.result;
					state.session.serverStarted = false;
					state.revision += 1;
					store.put(state, key);
				};
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
			});
		} finally {
			db.close();
		}
	}, userId);
}

// An online start is observed by the server and acknowledged back into the
// persisted timer. Browser clocks that fake elapsed time cannot move the
// server's clock, so those cases backdate the recorded start instead.
async function serverStartObserved(
	page: Page,
	userId: string,
	backdateSec = 0,
) {
	await expect
		.poll(async () => (await focusState(page, userId)).session?.serverStarted)
		.toBe(true);
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		if (backdateSec > 0)
			await pool.query(
				"update focus_interval_start set started_at = started_at - make_interval(secs => $2) where user_id=$1",
				[userId, backdateSec],
			);
		expect(
			(
				await pool.query(
					"select count(*)::int as count from focus_interval_start where user_id=$1",
					[userId],
				)
			).rows,
		).toEqual([{ count: 1 }]);
	} finally {
		await pool.end();
	}
}

for (const deferredDisk of [true, false]) {
	test(`offline completion survives reload with ${deferredDisk ? "deferred" : "persisted"} local queue`, async ({
		page,
		context,
	}) => {
		await page.addInitScript(installPersistenceControls);
		let refuseConnection = false;
		await context.routeWebSocket(/\/sync\/v\d+\/connect/, (socket) => {
			if (refuseConnection) socket.close();
			else socket.connectToServer();
		});
		test.setTimeout(150000);
		const userId = await startTask(page, 15);
		const timer = page.getByTestId("focus-timer");
		await timer.getByTestId("focus-pause").click();
		await expect(timer.getByTestId("focus-start")).toBeVisible();
		await expect(page.getByTestId("sync-indicator")).toHaveAttribute(
			"data-phase",
			"synced",
			{ timeout: 15000 },
		);
		const intervalId = (await focusState(page, userId)).session?.intervalId;
		expect(intervalId).toBeTruthy();
		await page.evaluate(
			({ marker, deferredDisk }) => {
				// Count only Zero disk transactions, never the independent focus intent.
				const put = IDBObjectStore.prototype.put;
				(window as unknown as { focusQueueWrites: number }).focusQueueWrites =
					0;
				IDBObjectStore.prototype.put = function (value, key) {
					if (
						this.transaction.db.name !== "ditero-focus" &&
						JSON.stringify(value).includes(marker)
					) {
						this.transaction.addEventListener(
							"complete",
							() => {
								(window as unknown as { focusQueueWrites: number })
									.focusQueueWrites++;
							},
							{ once: true },
						);
					}
					return key === undefined
						? put.call(this, value)
						: put.call(this, value, key);
				};
				if (deferredDisk) {
					window.__zeroCloseControls.marker = marker;
					window.__zeroCloseControls.idleHeld = true;
					window.__zeroCloseControls.idleRequests = 0;
				}
			},
			{ marker: intervalId ?? "", deferredDisk },
		);
		refuseConnection = true;
		await context.setOffline(true);
		await expect(page.getByTestId("sync-indicator")).toHaveAttribute(
			"data-phase",
			"offline",
			{ timeout: 20000 },
		);
		await timer.getByTestId("focus-start").click();
		await expect(timer.getByTestId("focus-phase")).toHaveText("Break", {
			timeout: 20000,
		});
		await openDetails(page, "Read together");
		await expect(page.getByTestId("task-time-on-task")).toHaveText(
			"15s focused",
		);
		const completion = (await focusState(page, userId)).pendingCompletions;
		expect(completion).toHaveLength(1);
		if (deferredDisk) {
			await expect
				.poll(() =>
					page.evaluate(() => window.__zeroCloseControls.idleRequests),
				)
				.toBeGreaterThan(0);
			expect(
				await page.evaluate(
					() =>
						(window as unknown as { focusQueueWrites: number })
							.focusQueueWrites,
				),
			).toBe(0);
		} else {
			await expect
				.poll(() =>
					page.evaluate(
						() =>
							(window as unknown as { focusQueueWrites: number })
								.focusQueueWrites,
					),
				)
				.toBeGreaterThan(0);
		}
		// HTTP stays available on reload while Zero remains disconnected.
		await context.setOffline(false);
		await page.reload();
		await expect(timer.getByTestId("focus-phase")).toHaveText("Break");
		expect((await focusState(page, userId)).pendingCompletions).toEqual(
			completion,
		);
		refuseConnection = false;
		const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
		try {
			await expect
				.poll(
					async () =>
						(
							await pool.query(
								"select duration_sec from focus_session where user_id=$1",
								[userId],
							)
						).rows,
					{ timeout: 45000 },
				)
				.toEqual([{ duration_sec: 15 }]);
			// A zero-type result can retain the intent until the next replay.
			await page.reload();
			await expect
				.poll(async () => (await focusState(page, userId)).pendingCompletions)
				.toEqual([]);
			expect(
				(
					await pool.query(
						"select count(*)::int as count from focus_session where user_id=$1",
						[userId],
					)
				).rows,
			).toEqual([{ count: 1 }]);
			expect(
				(
					await pool.query(
						"select count(*)::int as count from karma_event where user_id=$1",
						[userId],
					)
				).rows,
			).toEqual([{ count: 0 }]);
		} finally {
			await pool.end();
		}
	});
}

for (const correction of [-60000, 60000]) {
	test(`pause/resume displays and logs a complete interval after a ${correction} ms clock correction`, async ({
		page,
	}) => {
		await page.clock.install();
		const userId = await startTask(page, 60);
		await serverStartObserved(page, userId, 600);
		const timer = page.getByTestId("focus-timer");
		await page.clock.runFor(2000);
		await timer.getByTestId("focus-pause").click();
		await expect(timer.getByTestId("focus-start")).toBeVisible();
		const remaining = await timer.getByTestId("focus-countdown").innerText();
		const at = await page.evaluate(() => Date.now());
		await page.clock.setSystemTime(at + correction);
		await timer.getByTestId("focus-start").click();
		await expect(timer.getByTestId("focus-countdown")).toHaveText(remaining);
		await page.clock.runFor(61000);
		await expect(timer.getByTestId("focus-phase")).toHaveText("Break");
		const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
		try {
			await expect
				.poll(
					async () =>
						(
							await pool.query(
								"select duration_sec, (extract(epoch from (ended_at - started_at)) * 1000)::int as span from focus_session where user_id=$1",
								[userId],
							)
						).rows,
				)
				.toEqual([{ duration_sec: 60, span: 60000 }]);
		} finally {
			await pool.end();
		}
	});
}
