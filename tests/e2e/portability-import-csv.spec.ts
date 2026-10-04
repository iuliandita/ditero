import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
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
	await panel.getByTestId("import-provider-policy").check();
	await apply.click();
	await page.getByTestId("confirm-accept").click();
	await expect(panel.getByTestId("import-apply-status")).toContainText(
		"completed",
	);
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
