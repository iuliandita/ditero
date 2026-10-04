import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
	chooseOption,
	goToSettings,
	leaveSettings,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

const fixture = readFileSync(
	new URL(
		"../fixtures/portability/providers/todoist-project-v1.csv",
		import.meta.url,
	),
);
test("Todoist snapshot requires open-copy approval, resets changed input, preserves sections and refuses changed-byte reuse", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("todoist-snapshot"));
	await waitWorkspaceReady(page);
	const original = await (
		await page.request.get("/api/portability/export")
	).json();
	await goToSettings(page);
	const panel = page.getByRole("region", { name: "Plan an import" });
	await chooseOption(
		page,
		panel.getByTestId("import-format"),
		"Todoist project CSV snapshot",
	);
	await panel.getByTestId("import-todoist-project").fill("Imported project");
	await panel.getByTestId("import-todoist-unsectioned").fill("Unsectioned");
	const picker = panel.getByLabel("Todoist project CSV file");
	await picker.setInputFiles({
		name: "project.csv",
		mimeType: "text/csv",
		buffer: fixture,
	});
	await panel.getByLabel("Source label").fill("Todoist source");
	await expect(panel.getByTestId("import-workspace")).toHaveCount(1);
	await chooseOption(
		page,
		panel.getByTestId("import-workspace"),
		original.data.workspaces[0].name,
	);
	const save = panel.getByRole("button", { name: "Save dry run", exact: true });
	const policy = panel.getByTestId("import-provider-policy");
	await expect(save).toBeDisabled();
	await expect(panel).toContainText("Every task is an open copy");
	await policy.check();
	await expect(save).toBeEnabled();
	await panel.getByTestId("import-todoist-project").fill("Renamed project");
	await expect(policy).not.toBeChecked();
	await expect(save).toBeDisabled();
	await expect(panel.getByTestId("import-workspace")).toHaveCount(1);
	await panel.getByTestId("import-todoist-project").fill("Imported project");
	await expect(panel.getByTestId("import-workspace")).toHaveCount(1);
	await chooseOption(
		page,
		panel.getByTestId("import-workspace"),
		original.data.workspaces[0].name,
	);
	await policy.check();
	await page.setViewportSize({ width: 375, height: 812 });
	await page.evaluate(() => {
		document.documentElement.dir = "rtl";
	});
	const bounds = await panel.boundingBox();
	expect(bounds).not.toBeNull();
	expect(bounds?.x).toBeGreaterThanOrEqual(0);
	expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(375);
	expect(original.data.workspaces[0].name.length).toBeGreaterThan(40);
	for (const control of [
		panel.locator("fieldset"),
		panel.getByTestId("import-workspace"),
	]) {
		const controlBounds = await control.boundingBox();
		expect(controlBounds).not.toBeNull();
		expect(controlBounds?.x).toBeGreaterThanOrEqual(bounds?.x ?? 0);
		expect(
			(controlBounds?.x ?? 0) + (controlBounds?.width ?? 0),
		).toBeLessThanOrEqual((bounds?.x ?? 0) + (bounds?.width ?? 0));
	}
	expect(
		await panel.evaluate(
			(element) => element.scrollWidth <= element.clientWidth,
		),
	).toBe(true);
	expect(
		(await new AxeBuilder({ page }).include("#import-plan").analyze())
			.violations,
	).toEqual([]);
	await page.evaluate(() => {
		document.documentElement.dir = "ltr";
	});
	const saved = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/portability/import/plans") && response.ok(),
	);
	await save.click();
	const plan = await (await saved).json();
	expect(plan.inputBinding).toMatchObject({
		adapter: "todoist-project-csv",
		identityMode: "snapshot-rows",
		projectFolderName: "Imported project",
	});
	expect(plan.inputBinding.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
	const apply = panel.getByRole("button", {
		name: "Apply import",
		exact: true,
	});
	await expect(apply).toBeEnabled();
	await policy.uncheck();
	await expect(apply).toBeDisabled();
	await policy.check();
	await apply.click();
	await page.getByTestId("confirm-accept").click();
	await expect(panel.getByTestId("import-apply-status")).toContainText(
		"completed",
	);
	const imported = await (
		await page.request.get("/api/portability/export")
	).json();
	expect(imported.data.tasks).toHaveLength(3);
	expect(
		imported.data.tasks.every(
			(task: { done: boolean; dueAt: string | null }) =>
				!task.done && task.dueAt === null,
		),
	).toBe(true);
	expect(
		imported.data.lists.map((list: { title: string }) => list.title).sort(),
	).toEqual(["Empty section", "Same section", "Same section", "Unsectioned"]);
	expect(imported.data.comments).toEqual([]);
	await picker.setInputFiles({
		name: "changed.csv",
		mimeType: "text/csv",
		buffer: Buffer.from(fixture.toString().replace("every day", "tomorrow")),
	});
	await expect(policy).not.toBeChecked();
	await expect(apply).toHaveCount(0);
	await expect(panel.getByTestId("import-workspace")).toHaveCount(1);
	await chooseOption(
		page,
		panel.getByTestId("import-workspace"),
		original.data.workspaces[0].name,
	);
	await policy.check();
	const refused = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/portability/import/plans") &&
			response.status() === 409,
	);
	await save.click();
	expect(await (await refused).json()).toEqual({
		code: "source-binding-conflict",
	});
	await expect(panel.getByRole("alert")).toContainText(
		"Choose New source explicitly",
	);
	expect(
		(await (await page.request.get("/api/portability/export")).json()).data
			.tasks,
	).toEqual(imported.data.tasks);
	await chooseOption(page, panel.getByTestId("import-source"), "New source");
	await panel.getByLabel("Source label").fill("Separate snapshot");
	await expect(policy).not.toBeChecked();
	await policy.check();
	const newSaved = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/portability/import/plans") && response.ok(),
	);
	await save.click();
	const separate = await (await newSaved).json();
	expect(separate.sourceId).not.toBe(plan.sourceId);
	await leaveSettings(page);
	await page.reload();
	await waitWorkspaceReady(page);
	await goToSettings(page);
	const sourceBox = panel
		.getByText("Separate snapshot", { exact: true })
		.locator("..")
		.locator("..");
	await sourceBox.getByRole("button", { name: /^\d/ }).click();
	await expect(policy).not.toBeChecked();
	await expect(apply).toBeDisabled();
	await expect(panel).toContainText("Imported project");
	await policy.check();
	await expect(apply).toBeEnabled();
	await chooseOption(page, panel.getByTestId("import-format"), "Ditero CSV v1");
	await panel.getByLabel("Ditero CSV file").setInputFiles({
		name: "native-contract.csv",
		mimeType: "text/csv",
		buffer: readFileSync(
			new URL("../fixtures/portability/providers/csv-v1.csv", import.meta.url),
		),
	});
	await expect(panel.getByTestId("import-workspace")).toHaveCount(1);
	await chooseOption(
		page,
		panel.getByTestId("import-workspace"),
		original.data.workspaces[0].name,
	);
	await chooseOption(
		page,
		panel.getByTestId("import-source"),
		"Separate snapshot",
	);
	await policy.check();
	const csvConflict = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/portability/import/plans") &&
			response.status() === 409,
	);
	await save.click();
	expect(await (await csvConflict).json()).toEqual({
		code: "source-binding-conflict",
	});
	await expect(panel.getByRole("alert")).toContainText("The request failed");
	await expect(panel.getByRole("alert")).not.toContainText(
		"changed files cannot update this snapshot",
	);
});
