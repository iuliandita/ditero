import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { signUp, uniqueEmail, waitWorkspaceReady } from "./helpers.ts";

test.describe("habit table timezone", () => {
	test.use({ timezoneId: "UTC" });
	test("a Tokyo habit table shows its local day without changing ordinary overdue tasks", async ({
		page,
	}) => {
		const userId = await signUp(page, uniqueEmail("habit-table-zone"));
		await page.clock.setFixedTime(new Date("2026-10-01T03:00:00Z"));
		const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
		const habitListId = randomUUID();
		const taskListId = randomUUID();
		const viewId = randomUUID();
		try {
			const workspace = await pool.query<{ id: string }>(
				"select id from workspace where owner_id = $1 and kind = 'personal'",
				[userId],
			);
			if (!workspace.rows[0]) throw new Error("personal workspace not found");
			await pool.query(
				`insert into list (id, workspace_id, owner_id, title, kind, sort_key)
				 values ($1, $3, $4, 'Tokyo habits', 'habits', 'a0'),
				 ($2, $3, $4, 'Ordinary plans', 'tasks', 'a1')`,
				[habitListId, taskListId, workspace.rows[0].id, userId],
			);
			await pool.query(
				`insert into task (id, list_id, title, sort_key, due_at, due_all_day, rrule)
				 values ($1, $2, 'Tokyo daily check-in', 'a0', '2026-09-18T00:00:00Z', true, 'FREQ=DAILY'),
				 ($3, $4, 'Ordinary overdue plan', 'a0', '2026-09-29T00:00:00Z', true, null)`,
				[randomUUID(), habitListId, randomUUID(), taskListId],
			);
			await pool.query(
				`insert into view (id, owner_id, name, scope, filter, display, sort_key)
				 values ($1, $2, 'Tokyo table', 'personal', $3, $4, 'a0')`,
				[
					viewId,
					userId,
					JSON.stringify({ op: "and", conditions: [] }),
					JSON.stringify({
						layout: "table",
						groupBy: "none",
						sort: { field: "due", dir: "asc" },
						workspaceScope: { mode: "all" },
					}),
				],
			);
			await pool.query(
				`insert into user_pref (id, timezone, timezone_chosen, pinned_views)
				 values ($1, 'Asia/Tokyo', true, $2)
				 on conflict (id) do update set timezone = excluded.timezone,
				 timezone_chosen = true, pinned_views = excluded.pinned_views`,
				[userId, JSON.stringify([viewId])],
			);
		} finally {
			await pool.end();
		}
		await page.reload();
		await waitWorkspaceReady(page);
		await page
			.getByRole("navigation", { name: "Lists" })
			.getByRole("button", { name: "Tokyo table", exact: true })
			.click();
		const table = page.getByRole("table");
		const habitDue = table
			.getByRole("row")
			.filter({ hasText: "Tokyo daily check-in" })
			.getByRole("cell")
			.nth(1);
		await expect(habitDue).toHaveText("Oct 1");
		await expect(habitDue.locator("span")).not.toHaveClass(/text-destructive/);
		const ordinaryDue = table
			.getByRole("row")
			.filter({ hasText: "Ordinary overdue plan" })
			.getByRole("cell")
			.nth(1);
		await expect(ordinaryDue).toHaveText("Sep 29");
		await expect(ordinaryDue.locator("span")).toHaveClass(/text-destructive/);
	});
});

test("desktop aggregate capture exposes its destination", async ({ page }) => {
	await signUp(page, uniqueEmail("aggregate-capture"));
	await waitWorkspaceReady(page);
	await page.getByTestId("first-run-create-list").click();
	await page.getByTestId("new-list").fill("Household errands");
	await page.getByTestId("new-list-submit").click();
	await expect(page.getByTestId("list")).toBeVisible();
	await page.getByRole("button", { name: "Today", exact: true }).click();
	await expect(page.getByTestId("desktop-add-task")).toBeVisible();
	await page.getByTestId("desktop-add-task").click();
	await expect(page.getByTestId("quickadd-input")).toBeVisible();
	await expect(page.getByTestId("quickadd-dialog")).toBeVisible();
	await expect(page.getByText("Adding to Household errands")).toBeVisible();
});

test.describe("phone gestures", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
	for (const interruption of ["pointercancel", "lostpointercapture"] as const) {
		test(`${interruption} clears a swipe without completing or scheduling`, async ({
			page,
		}) => {
			await signUp(page, uniqueEmail("swipe-interruption"));
			await waitWorkspaceReady(page);
			await page.getByTestId("first-run-create-list").click();
			await page.getByTestId("new-list").fill("Weekly household planning");
			await page.getByTestId("new-list-submit").click();
			await expect(page.getByTestId("list")).toBeVisible();
			await page.getByTestId("new-task").fill("Book the bicycle service");
			await page.getByTestId("new-task-submit").click();
			const checkbox = page.getByRole("checkbox", {
				name: "Book the bicycle service",
				exact: true,
			});
			const row = page.locator("[data-kbd-row]").filter({ has: checkbox });
			const gesture = row.locator("..");
			await expect(checkbox).not.toBeChecked();
			const cdp = await page.context().newCDPSession(page);
			const startSwipe = async (distance: number) => {
				const bounds = await gesture.boundingBox();
				if (!bounds) throw new Error("missing swipe surface");
				const x = bounds.x + bounds.width / 2;
				const y = bounds.y + bounds.height / 2;
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchStart",
					touchPoints: [{ x, y }],
				});
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchMove",
					touchPoints: [{ x: x + distance, y }],
				});
			};
			for (const distance of [100, -100]) {
				await startSwipe(distance);
				await expect(gesture).toHaveCSS(
					"transform",
					`matrix(1, 0, 0, 1, ${distance}, 0)`,
				);
				await gesture.dispatchEvent(interruption, {
					pointerType: "touch",
					pointerId: 1,
				});
				await expect(gesture).toHaveCSS(
					"transform",
					"matrix(1, 0, 0, 1, 0, 0)",
				);
				await expect(checkbox).not.toBeChecked();
				await expect(
					page.getByRole("dialog", { name: /Schedule/ }),
				).toHaveCount(0);
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchEnd",
					touchPoints: [],
				});
				await expect(checkbox).not.toBeChecked();
			}
			// Native release must still commit after either interruption. Capture
			// transfers from the touched descendant to SwipeRow before pointerup,
			// so a bubbled descendant loss must not cancel the parent gesture.
			await startSwipe(100);
			await expect(gesture).toHaveCSS(
				"transform",
				"matrix(1, 0, 0, 1, 100, 0)",
			);
			await cdp.send("Input.dispatchTouchEvent", {
				type: "touchEnd",
				touchPoints: [],
			});
			await expect(page.getByTestId("completed-section")).toBeVisible();
			await page.getByTestId("completed-section").click();
			await expect(checkbox).toBeChecked();
		});
	}
});
