import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
	chooseOption,
	goToSettings,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

const cases = [
	{
		provider: "todoist",
		picker: "Todoist project CSV with content",
		file: "todoist-content.csv",
		tasks: 5,
		title: "Plan groceries",
		notice: "flattened to one level",
	},
	{
		provider: "ticktick",
		picker: "TickTick backup CSV",
		file: "ticktick-backup.csv",
		tasks: 6,
		title: "Return book",
		notice: "flattened to one level",
	},
	{
		provider: "microsoft",
		picker: "Microsoft To Do via Outlook CSV",
		file: "microsoft-todo-outlook.csv",
		tasks: 2,
		title: "Prepare weekend list",
		notice: "selected folder",
	},
	{
		provider: "trello",
		picker: "Trello board JSON with content",
		file: "trello-content.json",
		tasks: 4,
		title: "Prepare picnic",
		notice: "recent comments",
	},
	{
		provider: "generic-csv",
		picker: "Generic task CSV",
		file: "generic-tasks.csv",
		tasks: 3,
		title: "=SUM(1,2)",
		notice: "duplicate row",
	},
];
for (const item of cases)
	test(`${item.provider} picker previews notices, applies safely and reuses exact snapshots without duplicates`, async ({
		page,
	}) => {
		await signUp(page, uniqueEmail(`content-${item.provider}`));
		await waitWorkspaceReady(page);
		const original = await (
			await page.request.get("/api/portability/export")
		).json();
		await goToSettings(page);
		const panel = page.getByRole("region", { name: "Plan an import" });
		await chooseOption(page, panel.getByTestId("import-format"), item.picker);
		await panel.getByTestId("import-content-timezone").fill("UTC");
		const fixture = readFileSync(
			new URL(
				`../fixtures/portability/providers/${item.file}`,
				import.meta.url,
			),
		);
		const picker = panel.getByLabel("Provider export file");
		await picker.setInputFiles({
			name: item.file,
			mimeType: item.file.endsWith("json") ? "application/json" : "text/csv",
			buffer: fixture,
		});
		await panel.getByLabel("Source label").fill(`${item.provider} source`);
		await expect(panel.getByTestId("import-workspace")).toHaveCount(1);
		await chooseOption(
			page,
			panel.getByTestId("import-workspace"),
			original.data.workspaces[0].name,
		);
		const notices = panel.getByTestId("import-content-notices");
		await expect(notices).toBeVisible();
		await expect(notices).toContainText(item.notice);
		const policy = panel.getByTestId("import-provider-policy"),
			save = panel.getByRole("button", { name: "Save dry run", exact: true });
		await expect(save).toBeDisabled();
		await policy.check();
		await expect(save).toBeEnabled();
		const saved = page.waitForResponse(
			(response) =>
				response.url().endsWith("/api/portability/import/plans") &&
				response.ok(),
		);
		await save.click();
		const plan = await (await saved).json();
		expect(plan.inputBinding).toMatchObject({
			adapter: "provider-content",
			provider: item.provider,
			timezone: "UTC",
		});
		expect(
			(await (await page.request.get("/api/portability/export")).json()).data
				.tasks,
		).toEqual(original.data.tasks);
		const apply = panel.getByRole("button", {
			name: "Apply import",
			exact: true,
		});
		await apply.click();
		await page.getByTestId("confirm-accept").click();
		await expect(panel.getByTestId("import-apply-status")).toContainText(
			"completed",
		);
		const imported = await (
			await page.request.get("/api/portability/export")
		).json();
		expect(imported.data.tasks).toHaveLength(item.tasks);
		expect(
			imported.data.tasks.find(
				(task: { title: string }) => task.title === item.title,
			),
		).toBeDefined();
		expect(imported.data.assignments).toEqual([]);
		expect(imported.data.comments).toEqual([]);
		// Uploading the same bytes clears consent and returns to the preview using the selected source.
		await picker.setInputFiles({
			name: item.file,
			mimeType: item.file.endsWith("json") ? "application/json" : "text/csv",
			buffer: fixture,
		});
		await expect(policy).not.toBeChecked();
		await expect(panel.getByTestId("import-workspace")).toHaveCount(1);
		await chooseOption(
			page,
			panel.getByTestId("import-workspace"),
			original.data.workspaces[0].name,
		);
		await policy.check();
		const repeated = page.waitForResponse(
			(response) =>
				response.url().endsWith("/api/portability/import/plans") &&
				response.ok(),
		);
		await save.click();
		expect((await (await repeated).json()).sourceId).toBe(plan.sourceId);
		await apply.click();
		await page.getByTestId("confirm-accept").click();
		await expect(panel.getByTestId("import-apply-status")).toContainText(
			"completed",
		);
		expect(
			(await (await page.request.get("/api/portability/export")).json()).data
				.tasks,
		).toEqual(imported.data.tasks);
	});
