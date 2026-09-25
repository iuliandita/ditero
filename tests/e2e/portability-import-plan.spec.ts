import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
	goToSettings,
	leaveSettings,
	sidebarLists,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

test("saves and deduplicates a dry run without changing tasks, then discards it", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("import-plan"));
	await waitWorkspaceReady(page);
	await page.getByTestId("new-list").fill("Import dry-run check");
	await page.getByTestId("new-list-submit").click();
	await sidebarLists(page)
		.getByRole("button", { name: "Import dry-run check", exact: true })
		.last()
		.click();
	await page.getByTestId("new-task").fill("Keep this task unchanged");
	await page.getByTestId("new-task-submit").click();
	await expect(
		page
			.getByTestId("list")
			.getByText("Keep this task unchanged", { exact: true }),
	).toBeVisible();
	await goToSettings(page);
	const downloadEvent = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download JSON" }).click();
	const download = await downloadEvent;
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	const document = Buffer.concat(chunks);
	const exported = JSON.parse(document.toString("utf8"));
	expect(exported.data.tasks).toHaveLength(1);
	const panel = page.getByRole("region", { name: "Plan an import" });
	await panel.getByLabel("Native JSON export").setInputFiles({
		name: "export.json",
		mimeType: "application/json",
		buffer: document,
	});
	await panel.getByLabel("Source label").fill("Original account");
	await expect(panel.getByTestId("import-workspace")).toHaveCount(
		exported.data.workspaces.length,
	);
	for (const select of await panel.getByTestId("import-workspace").all())
		await select.selectOption(exported.data.workspaces[0].id);
	// Lose the response after persistence, then retry the same source identity.
	let firstId = "";
	await page.route(
		"**/api/portability/import/plans",
		async (route) => {
			const response = await route.fetch();
			expect(response.ok()).toBeTruthy();
			firstId = (await response.json()).id;
			await route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({ code: "unavailable" }),
			});
		},
		{ times: 1 },
	);
	await panel.getByRole("button", { name: "Save dry run" }).click();
	await expect(panel.getByRole("alert")).toContainText("The request failed");
	const retry = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/portability/import/plans") &&
			response.status() === 200,
	);
	await panel.getByRole("button", { name: "Save dry run" }).click();
	expect((await (await retry).json()).id).toBe(firstId);
	await expect(panel.getByRole("status").first()).toContainText(
		"Supported folders, your lists",
	);
	await expect(
		panel.getByRole("button", { name: "Discard dry run", exact: true }),
	).toHaveCount(1);
	const screenshotPath = test.info().outputPath("import-dry-run-settings.png");
	await panel.screenshot({ path: screenshotPath });
	await test.info().attach("import-dry-run-settings", {
		path: screenshotPath,
		contentType: "image/png",
	});
	expect(
		(await new AxeBuilder({ page }).include("#import-plan").analyze())
			.violations,
	).toEqual([]);
	await page.route(
		"**/api/portability/import/plans/*/apply",
		(route) =>
			route.fulfill({
				status: 409,
				contentType: "application/json",
				body: JSON.stringify({ code: "activation-readiness-limit" }),
			}),
		{ times: 1 },
	);
	await panel.getByRole("button", { name: "Apply import" }).click();
	await page.getByTestId("confirm-accept").click();
	await expect(panel.getByRole("alert")).toContainText(
		"This import stopped because its saved conditions changed",
	);
	await expect(
		panel.getByRole("button", { name: "Resume import" }),
	).toBeDisabled();
	const after = await page.request.get("/api/portability/export");
	expect((await after.json()).data.tasks).toEqual(exported.data.tasks);
	await panel
		.getByRole("button", { name: "Discard dry run", exact: true })
		.click();
	await page.getByTestId("confirm-accept").click();
	await expect(
		panel.getByRole("button", { name: "Discard dry run", exact: true }),
	).toHaveCount(0);
	await panel
		.getByRole("button", { name: "Discard source", exact: true })
		.click();
	await page.getByTestId("confirm-accept").click();
	await expect(
		panel.getByRole("button", { name: "Discard source", exact: true }),
	).toHaveCount(0);
});

test("rejects malformed files locally without saving a plan", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("import-invalid"));
	await waitWorkspaceReady(page);
	await goToSettings(page);
	const panel = page.getByRole("region", { name: "Plan an import" });
	await panel.getByLabel("Native JSON export").setInputFiles({
		name: "invalid.json",
		mimeType: "application/json",
		buffer: Buffer.from('{"format":"ditero"}'),
	});
	await expect(panel.getByRole("alert")).toContainText(
		"not a valid native export",
	);
	await expect(
		panel.getByRole("button", { name: "Save dry run" }),
	).toBeDisabled();
});

test("imports assignments, recovers a lost response, and supports ordinary unassign", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("import-apply"));
	await waitWorkspaceReady(page);
	await page.getByTestId("new-list").fill("Import execution check");
	await page.getByTestId("new-list-submit").click();
	await sidebarLists(page)
		.getByRole("button", { name: "Import execution check", exact: true })
		.last()
		.click();
	await page.getByTestId("new-task").fill("A task to import");
	await page.getByTestId("new-task-submit").click();
	await expect(
		page.getByTestId("list").getByText("A task to import", { exact: true }),
	).toBeVisible();
	await page
		.getByTestId("list")
		.getByRole("button", { name: "A task to import", exact: true })
		.click();
	await page.getByTestId("assignee-open").click();
	const self = page
		.getByTestId("assignee-picker")
		.getByTestId("assignee-option")
		.first();
	await self.click();
	await expect(self).toHaveAttribute("aria-pressed", "true");
	await page.keyboard.press("Escape");
	await page
		.getByRole("dialog", { name: "Task details" })
		.getByRole("button", { name: "Close" })
		.click();
	await expect
		.poll(
			async () =>
				(await (await page.request.get("/api/portability/export")).json()).data
					.assignments.length,
		)
		.toBe(1);
	const original = await (
		await page.request.get("/api/portability/export")
	).json();
	expect(original.data.tasks).toHaveLength(1);
	expect(original.data.assignments).toHaveLength(1);
	expect(original.data.assignments[0].userId).toBe(original.sourceUserId);
	const importDocument = structuredClone(original);
	importDocument.data.tasks[0].title = "Imported assigned task";
	importDocument.data.tasks[0].dueAt = "2030-01-15T15:00:00.000Z";
	importDocument.data.tasks[0].reminderTime = "09:00";
	importDocument.data.tasks[0].rrule = "FREQ=DAILY";
	importDocument.data.tasks[0].fallbackUserId = original.sourceUserId;
	importDocument.data.lists.find(
		(list: { id: string }) => list.id === importDocument.data.tasks[0].listId,
	).title = "Imported assigned list";
	await goToSettings(page);
	const panel = page.getByRole("region", { name: "Plan an import" });
	await panel.getByLabel("Native JSON export").setInputFiles({
		name: "export.json",
		mimeType: "application/json",
		buffer: Buffer.from(JSON.stringify(importDocument)),
	});
	await panel.getByLabel("Source label").fill("Confirmed import source");
	await expect(panel.getByTestId("import-workspace")).toHaveCount(
		original.data.workspaces.length,
	);
	for (const select of await panel.getByTestId("import-workspace").all())
		await select.selectOption(original.data.workspaces[0].id);
	await expect(
		panel.getByText("Each mapped person must belong", { exact: false }),
	).toBeVisible();
	const saved = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/portability/import/plans") && response.ok(),
	);
	await panel
		.getByRole("button", { name: "Save dry run", exact: true })
		.click();
	const savedPlan = await (await saved).json();
	expect(savedPlan.report.plannerVersion).toBe(4);
	const eligible =
		importDocument.data.folders.length +
		importDocument.data.lists.length +
		importDocument.data.labels.length +
		importDocument.data.tasks.length +
		importDocument.data.taskLabels.length +
		importDocument.data.assignments.length;
	const ignored =
		importDocument.data.principals.length +
		importDocument.data.workspaces.length +
		importDocument.data.memberships.length;
	const blocked =
		importDocument.data.userPrefs.length +
		importDocument.data.karma.length +
		importDocument.data.karmaEvents.length +
		importDocument.data.habitLogs.length;
	expect(savedPlan.report.counts).toEqual({
		ensure: eligible,
		ignored,
		blocked,
	});
	await expect(panel.getByRole("status").first()).toContainText(
		"No invitations or assignment notifications are sent",
	);
	const apply = panel.getByRole("button", {
		name: "Apply import",
		exact: true,
	});
	await expect(apply).toBeEnabled();
	await apply.click();
	await expect(page.getByRole("alertdialog")).toContainText(
		`Eligible: ${eligible}. Ignored: ${ignored}. Blocked: ${blocked}.`,
	);
	await page.getByTestId("confirm-cancel").click();
	expect(
		(await (await page.request.get("/api/portability/export")).json()).data
			.assignments,
	).toEqual(original.data.assignments);
	expect(
		(await (await page.request.get("/api/portability/export")).json()).data
			.tasks,
	).toEqual(original.data.tasks);
	await page.route(
		"**/api/portability/import/plans/*/apply",
		async (route) => {
			const response = await route.fetch();
			expect(response.ok()).toBeTruthy();
			expect((await response.json()).state).toBe("completed");
			await route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({ code: "unavailable" }),
			});
		},
		{ times: 1 },
	);
	await apply.click();
	await page.getByTestId("confirm-accept").click();
	await expect(panel.getByRole("alert")).toBeVisible();
	await panel
		.getByRole("button", { name: "Resume import", exact: true })
		.click();
	await expect(panel.getByTestId("import-apply-status")).toContainText(
		"completed",
	);
	const after = await (
		await page.request.get("/api/portability/export")
	).json();
	expect(after.data.tasks).toHaveLength(2);
	expect(
		new Set(after.data.tasks.map((row: { id: string }) => row.id)).size,
	).toBe(2);
	expect(
		after.data.tasks.map((row: { title: string }) => row.title).sort(),
	).toEqual(["A task to import", "Imported assigned task"]);
	const importedTask = after.data.tasks.find(
		(row: { title: string }) => row.title === "Imported assigned task",
	);
	expect(importedTask).toMatchObject({
		dueAt: "2030-01-15T15:00:00.000Z",
		reminderTime: "09:00",
		rrule: "FREQ=DAILY",
		fallbackUserId: original.sourceUserId,
	});
	expect(after.data.assignments).toHaveLength(2);
	expect(after.data.assignments).toContainEqual({
		id: `${importedTask.id}:${original.sourceUserId}`,
		taskId: importedTask.id,
		userId: original.sourceUserId,
	});
	const screenshot = test.info().outputPath("import-apply-completed.png");
	await panel.screenshot({ path: screenshot });
	await test.info().attach("import-apply-completed", {
		path: screenshot,
		contentType: "image/png",
	});
	expect(
		(await new AxeBuilder({ page }).include("#import-plan").analyze())
			.violations,
	).toEqual([]);
	await leaveSettings(page);
	await sidebarLists(page)
		.getByRole("button", { name: "Imported assigned list", exact: true })
		.click();
	const task = page
		.getByTestId("list")
		.locator("button", { hasText: "Imported assigned task" });
	await expect(task.getByTestId("assignee-chips")).toBeVisible();
	await task.click();
	await page.getByTestId("assignee-open").click();
	const importedSelf = page
		.getByTestId("assignee-picker")
		.getByTestId("assignee-option")
		.first();
	await expect(importedSelf).toHaveAttribute("aria-pressed", "true");
	await importedSelf.click();
	await expect(importedSelf).toHaveAttribute("aria-pressed", "false");
	await expect
		.poll(
			async () =>
				(await (await page.request.get("/api/portability/export")).json()).data
					.assignments,
		)
		.toEqual(original.data.assignments);
	await page.reload();
	await waitWorkspaceReady(page);
	await sidebarLists(page)
		.getByRole("button", { name: "Imported assigned list", exact: true })
		.click();
	await expect(task.getByTestId("assignee-chips")).toHaveCount(0);
});
