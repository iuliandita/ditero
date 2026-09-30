import { expect, test } from "@playwright/test";
import { signUp, uniqueEmail, waitWorkspaceReady } from "./helpers.ts";

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
