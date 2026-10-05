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
	new URL(
		"../fixtures/portability/providers/trello-board-v1.json",
		import.meta.url,
	),
);

test("Trello JSON requires exclusion approval and imports plain open cards through preview and apply", async ({
	page,
}, testInfo) => {
	await signUp(page, uniqueEmail("trello-import"));
	await waitWorkspaceReady(page);
	const original = await (
		await page.request.get("/api/portability/export")
	).json();
	await goToSettings(page);
	const panel = page.getByRole("region", { name: "Plan an import" });
	await chooseOption(
		page,
		panel.getByTestId("import-format"),
		"Trello board JSON (v1)",
	);
	await panel.getByLabel("Trello board JSON file").setInputFiles({
		name: "board.json",
		mimeType: "application/json",
		buffer: fixture,
	});
	await panel.getByLabel("Source label").fill("Trello source");
	await expect(panel).toContainText("Import source:");
	await expect(panel).not.toContainText("CSV source namespace");
	await expect(panel.getByTestId("import-workspace")).toHaveCount(1);
	await chooseOption(
		page,
		panel.getByTestId("import-workspace"),
		original.data.workspaces[0].name,
	);
	const policy = panel.getByTestId("import-provider-policy");
	const save = panel.getByRole("button", { name: "Save dry run", exact: true });
	await expect(save).toBeDisabled();
	await expect(panel).toContainText("Archived boards, lists or cards");
	await expect(panel).toContainText(
		"each source is bound to the exact file bytes",
	);
	await policy.check();
	await expect(save).toBeEnabled();
	await page.setViewportSize({ width: 375, height: 812 });
	const bounds = await panel.boundingBox();
	expect(bounds).not.toBeNull();
	expect(bounds?.x).toBeGreaterThanOrEqual(0);
	expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(375);
	expect(
		await panel.evaluate(
			(element) => element.scrollWidth <= element.clientWidth,
		),
	).toBe(true);
	expect(
		(await new AxeBuilder({ page }).include("#import-plan").analyze())
			.violations,
	).toEqual([]);
	await page.screenshot({
		path: testInfo.outputPath("trello-mobile-preview.png"),
		fullPage: true,
	});
	const saved = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/portability/import/plans") && response.ok(),
	);
	await save.click();
	const plan = await (await saved).json();
	expect(plan.inputBinding).toMatchObject({
		adapter: "trello-board-json",
		identityMode: "stable-ids",
	});
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
	await expect(
		panel.getByRole("button", { name: "Resume import", exact: true }),
	).toHaveCount(0);
	await expect(apply).toHaveCount(0);
	const imported = await (
		await page.request.get("/api/portability/export")
	).json();
	expect(imported.data.tasks).toHaveLength(4);
	expect(
		imported.data.tasks.every(
			(task: {
				done: boolean;
				dueAt: string | null;
				parentId: string | null;
			}) => !task.done && task.dueAt === null && task.parentId === null,
		),
	).toBe(true);
	expect(
		imported.data.lists
			.map((list: { title: string; kind: string }) => ({
				title: list.title,
				kind: list.kind,
			}))
			.sort((a: { title: string }, b: { title: string }) =>
				a.title.localeCompare(b.title),
			),
	).toEqual([
		{ title: "Doing ünïcode ✓", kind: "tasks" },
		{ title: "Done", kind: "tasks" },
		{ title: "To do", kind: "tasks" },
	]);
	expect(imported.data.comments).toEqual([]);
	expect(imported.data.assignments).toEqual([]);
	expect(imported.data.labels).toEqual([]);

	await panel.getByLabel("Trello board JSON file").setInputFiles({
		name: "changed.json",
		mimeType: "application/json",
		buffer: Buffer.from(
			fixture.toString().replace("Write plan", "Updated plan"),
		),
	});
	await expect(policy).not.toBeChecked();
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
	await leaveSettings(page);
	await page.setViewportSize({ width: 1280, height: 900 });
	await sidebarLists(page)
		.getByRole("button", { name: "To do", exact: true })
		.click();
	await expect(
		page
			.getByTestId("list")
			.getByRole("checkbox", { name: "Write plan", exact: true }),
	).toBeVisible();
	await expect(
		page
			.getByTestId("list")
			.getByRole("checkbox", { name: "Review", exact: true }),
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("trello-imported-list.png"),
		fullPage: true,
	});
});

test("Trello file replacement resets approval and archived or foreign cards cannot reach preview", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("trello-refused"));
	await waitWorkspaceReady(page);
	await goToSettings(page);
	const panel = page.getByRole("region", { name: "Plan an import" });
	await chooseOption(
		page,
		panel.getByTestId("import-format"),
		"Trello board JSON (v1)",
	);
	const picker = panel.getByLabel("Trello board JSON file");
	await picker.setInputFiles({
		name: "board.json",
		mimeType: "application/json",
		buffer: fixture,
	});
	await expect(panel.getByTestId("import-provider-policy")).toBeVisible();
	await panel.getByTestId("import-provider-policy").check();
	for (const foreign of [false, true]) {
		const board = JSON.parse(fixture.toString()) as {
			cards: { idList: string; closed: boolean }[];
		};
		if (foreign) board.cards[0].idList = "111111111111111111111111";
		else board.cards[0].closed = true;
		await picker.setInputFiles({
			name: foreign ? "foreign.json" : "archived.json",
			mimeType: "application/json",
			buffer: Buffer.from(JSON.stringify(board)),
		});
		await expect(panel.getByRole("alert")).toContainText(
			"not a supported Trello board JSON export",
		);
		await expect(
			panel.getByRole("button", { name: "Save dry run", exact: true }),
		).toBeDisabled();
		await expect(
			panel.getByRole("button", { name: "Apply import", exact: true }),
		).toHaveCount(0);
	}
	await picker.setInputFiles({
		name: "board.json",
		mimeType: "application/json",
		buffer: fixture,
	});
	await expect(panel.getByTestId("import-provider-policy")).not.toBeChecked();
	expect(
		(await (await page.request.get("/api/portability/export")).json()).data
			.tasks,
	).toEqual([]);
});
