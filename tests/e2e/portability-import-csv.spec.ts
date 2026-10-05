import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Route, test } from "@playwright/test";
import {
	chooseOption,
	goToSettings,
	leaveSettings,
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

const fixture = readFileSync(
	new URL("../fixtures/portability/providers/csv-v1.csv", import.meta.url),
);
test.use({ hasTouch: true });

test("CSV original-file workflow requires policy acknowledgment, applies and replays stable IDs", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("csv-import"));
	await waitWorkspaceReady(page);
	const original = await (
		await page.request.get("/api/portability/export")
	).json();
	await goToSettings(page);
	const panel = page.getByRole("region", { name: "Plan an import" });
	await chooseOption(page, panel.getByTestId("import-format"), "Ditero CSV v1");
	const picker = panel.getByLabel("Ditero CSV file");
	await picker.setInputFiles({
		name: "tasks.csv",
		mimeType: "text/csv",
		buffer: fixture,
	});
	await panel.getByLabel("Source label").fill("CSV source");
	await expect(panel.getByTestId("import-workspace")).toHaveCount(1);
	await chooseOption(
		page,
		panel.getByTestId("import-workspace"),
		original.data.workspaces[0].name,
	);
	const save = panel.getByRole("button", { name: "Save dry run", exact: true });
	await expect(save).toBeDisabled();
	await expect(panel).toContainText("fcb28f31-12ae-4c9d-82f2-1289d9fcb411");
	await expect(panel).toContainText("task creation times and urgency");
	await panel.getByTestId("import-provider-policy").check();
	const saved = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/portability/import/plans") && response.ok(),
	);
	await save.click();
	const plan = await (await saved).json();
	expect(plan.report.plannerVersion).toBe(4);
	expect(plan.inputBinding).toMatchObject({
		adapter: "ditero-csv",
		identityMode: "stable-ids",
	});
	expect(
		(await (await page.request.get("/api/portability/export")).json()).data
			.tasks,
	).toHaveLength(0);
	const apply = panel.getByRole("button", {
		name: "Apply import",
		exact: true,
	});
	await expect(apply).toBeEnabled();
	await panel.getByTestId("import-provider-policy").uncheck();
	await expect(apply).toBeDisabled();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(apply).toHaveAccessibleDescription(
		"Accept the exclusions above to enable this action.",
	);
	expect(
		await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
	).toBe(true);
	const applyBounds = await apply.boundingBox();
	expect(applyBounds?.height).toBeGreaterThanOrEqual(44);
	expect(applyBounds?.x).toBeGreaterThanOrEqual(0);
	expect((applyBounds?.x ?? 0) + (applyBounds?.width ?? 0)).toBeLessThanOrEqual(
		390,
	);
	await apply.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: test.info().outputPath("import-blocked-mobile.png"),
		fullPage: false,
	});
	const afterMobileCapture = await page.evaluate(() => ({
		coarse: matchMedia("(pointer: coarse)").matches,
		fine: matchMedia("(pointer: fine)").matches,
		maxTouchPoints: navigator.maxTouchPoints,
		viewportWidth: innerWidth,
		viewportHeight: innerHeight,
	}));
	await test.info().attach("blocked-mobile-after-capture-pointer", {
		body: JSON.stringify(afterMobileCapture, null, 2),
		contentType: "application/json",
	});
	expect(afterMobileCapture.coarse).toBe(true);
	expect(afterMobileCapture.maxTouchPoints).toBeGreaterThan(0);
	await panel.getByTestId("import-provider-policy").check();
	let releaseApply = () => {};
	const heldApply = new Promise<void>((resolve) => {
		releaseApply = resolve;
	});
	await page.route(
		`**/api/portability/import/plans/${plan.id}/apply`,
		async (route) => {
			const response = await route.fetch();
			expect(response.ok()).toBe(true);
			expect((await response.json()).state).toBe("completed");
			await heldApply;
			await route.fulfill({ response });
		},
		{ times: 1 },
	);
	await apply.click();
	await page.getByTestId("confirm-accept").click();
	try {
		const pause = panel.getByRole("button", {
			name: "Pause import",
			exact: true,
		});
		await pause.focus();
		await expect(pause).toBeFocused();
		const pointerPremise = await pause.evaluate((element) => {
			const style = getComputedStyle(element);
			const bounds = element.getBoundingClientRect();
			return {
				coarse: matchMedia("(pointer: coarse)").matches,
				fine: matchMedia("(pointer: fine)").matches,
				anyCoarse: matchMedia("(any-pointer: coarse)").matches,
				viewportWidth: innerWidth,
				maxTouchPoints: navigator.maxTouchPoints,
				computedMinHeight: style.minHeight,
				computedHeight: style.height,
				actualHeight: bounds.height,
				spacing: style.getPropertyValue("--spacing").trim(),
				classes: element.className,
			};
		});
		await test.info().attach("pause-pointer-premise", {
			body: JSON.stringify(pointerPremise, null, 2),
			contentType: "application/json",
		});
		expect(pointerPremise.coarse).toBe(true);
		expect(pointerPremise.actualHeight).toBeGreaterThanOrEqual(44);
		await page.screenshot({
			path: test.info().outputPath("import-running-mobile.png"),
			fullPage: false,
		});
		await page.setViewportSize({ width: 1280, height: 900 });
		await pause.focus();
		await expect(pause).toBeFocused();
		await panel.screenshot({
			path: test.info().outputPath("import-running-desktop.png"),
		});
	} finally {
		releaseApply();
	}
	await expect(panel.getByTestId("import-apply-status")).toContainText(
		"completed",
	);
	await expect(
		panel.getByRole("button", { name: "Pause import", exact: true }),
	).toHaveCount(0);
	await expect(panel.getByTestId("import-apply-status")).toBeFocused();
	await panel.screenshot({
		path: test.info().outputPath("import-completed-focus-desktop.png"),
	});
	const imported = await (
		await page.request.get("/api/portability/export")
	).json();
	expect(
		imported.data.tasks.map((row: { title: string }) => row.title).sort(),
	).toEqual(["Buy apples", "Prepare groceries"]);
	expect(imported.data.assignments).toEqual([]);
	await picker.setInputFiles({
		name: "broken.csv",
		mimeType: "text/csv",
		buffer: Buffer.from([255]),
	});
	await expect(panel.getByRole("alert")).toContainText(
		"not a valid Ditero CSV v1",
	);
	await expect(apply).toHaveCount(0);
	await expect(panel.getByTestId("import-apply-status")).toHaveCount(0);
	const runPath = `**/api/portability/import/plans/${plan.id}/run`;
	const unavailableRun = async (route: Route) => {
		const response = await route.fetch();
		expect(response.ok()).toBe(true);
		expect((await response.json()).run.state).toBe("completed");
		await route.fulfill({ status: 503 });
	};
	// Strict Mode can abort the first mount read; fail every initial read.
	await page.route(runPath, unavailableRun);
	const unavailableResponse = page.waitForResponse(
		(response) =>
			response.url().endsWith(`/plans/${plan.id}/run`) &&
			response.status() === 503,
	);
	await panel.getByRole("button", { name: /^\d/ }).first().click();
	const retry = panel.getByRole("button", {
		name: "Check progress again",
		exact: true,
	});
	expect((await unavailableResponse).status()).toBe(503);
	await expect(retry).toBeDisabled();
	await page.unroute(runPath, unavailableRun);
	await expect(retry).toHaveAccessibleDescription(
		"Accept the exclusions above to enable this action.",
	);
	await panel.screenshot({
		path: test.info().outputPath("import-blocked-desktop.png"),
	});
	await panel.getByTestId("import-provider-policy").check();
	let releaseRun = () => {};
	const heldRun = new Promise<void>((resolve) => {
		releaseRun = resolve;
	});
	await page.route(
		runPath,
		async (route) => {
			const response = await route.fetch();
			expect(response.ok()).toBe(true);
			expect((await response.json()).run.state).toBe("completed");
			await heldRun;
			await route.fulfill({ response });
		},
		{ times: 1 },
	);
	await retry.focus();
	await expect(retry).toBeFocused();
	await retry.press("Enter");
	try {
		await expect(panel.getByTestId("import-apply-status")).toHaveText(
			"Checking import progress…",
		);
	} finally {
		releaseRun();
	}
	await expect(panel.getByTestId("import-apply-status")).toContainText(
		"Import completed.",
	);
	await expect(panel.getByTestId("import-apply-status")).toBeFocused();
	await expect(
		panel.getByRole("button", { name: "Apply import", exact: true }),
	).toHaveCount(0);
	const lines = fixture.toString().trimEnd().split("\n");
	await picker.setInputFiles({
		name: "reordered.csv",
		mimeType: "text/csv",
		buffer: Buffer.from(
			`${[lines[0], ...lines.slice(1).reverse()].join("\n")}\n`,
		),
	});
	await expect(panel.getByTestId("import-workspace")).toHaveCount(1);
	await chooseOption(
		page,
		panel.getByTestId("import-workspace"),
		original.data.workspaces[0].name,
	);
	await expect(save).toBeDisabled();
	await panel.getByTestId("import-provider-policy").check();
	const replayResponse = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/portability/import/plans") && response.ok(),
	);
	await save.click();
	const replay = await (await replayResponse).json();
	expect(replay.documentDigest).toBe(plan.documentDigest);
	await panel
		.getByRole("button", { name: "Apply import", exact: true })
		.click();
	await page.getByTestId("confirm-accept").click();
	await expect(panel.getByTestId("import-apply-status")).toContainText(
		"completed",
	);
	expect(
		(await (await page.request.get("/api/portability/export")).json()).data
			.tasks,
	).toEqual(imported.data.tasks);
	expect(
		(await new AxeBuilder({ page }).include("#import-plan").analyze())
			.violations,
	).toEqual([]);
	await leaveSettings(page);
	await page.reload();
	await waitWorkspaceReady(page);
	await expect(
		sidebarLists(page).getByRole("button", { name: "Shopping", exact: true }),
	).toBeVisible();
});
