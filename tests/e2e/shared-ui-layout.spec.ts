import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { openDetails, sidebarLists, signUp, uniqueEmail } from "./helpers.ts";

test.describe.configure({ timeout: 120_000 });

test("a live reminder leaves the task title readable beside the sidebar and details", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1100, height: 800 });
	const user = await signUp(page, uniqueEmail("row-width"));
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	const list = randomUUID();
	const task = randomUUID();
	try {
		const {
			rows: [membership],
		} = await pool.query(
			"select workspace_id from membership where user_id=$1",
			[user],
		);
		await pool.query(
			"insert into list(id,workspace_id,owner_id,title,kind,sort_key) values($1,$2,$3,'Reminder layout','tasks','a0')",
			[list, membership.workspace_id, user],
		);
		await pool.query(
			"insert into task(id,list_id,title,sort_key,priority,due_at,due_all_day) values($1,$2,'Read the reminder task','a0',3,now()+interval '1 hour',false)",
			[task, list],
		);
		await pool.query(
			"insert into task(id,list_id,parent_id,title,sort_key) values($1,$2,$3,'One subtask','a1')",
			[randomUUID(), list, task],
		);
		await pool.query(
			"insert into reminder_state(id,task_id,occurrence_at,recipient_user_id,status) values($1,$2,now()+interval '1 hour',$3,'pending')",
			[randomUUID(), task, user],
		);
		await pool.query(
			'insert into notification_channel(id,user_id,kind,config,enabled) values($1,$2,\'ntfy\',\'{"serverUrl":"https://notify.example.test","topic":"layout"}\',true)',
			[randomUUID(), user],
		);
		const nav = sidebarLists(page).getByRole("button", {
			name: "Reminder layout",
			exact: true,
		});
		await expect(nav.first()).toBeVisible({ timeout: 15_000 });
		await nav.first().click();
		await openDetails(page, "Read the reminder task");
		await expect(page.getByTestId("task-detail-close")).toBeVisible();
		await expect(sidebarLists(page)).toBeVisible();
		const row = page
			.getByTestId("list")
			.locator("[data-kbd-row]")
			.filter({ has: page.locator(`[data-task-id="${task}"]`) });
		const title = row.locator("[data-reading-title]");
		const chip = row.getByTestId("reminder-chip");
		await expect(chip).toBeVisible();
		await expect(row.getByTestId("reminder-unverified-note")).toBeVisible();
		await expect(row.getByTestId("subtask-count")).toBeVisible();
		await expect
			.poll(async () => (await title.boundingBox())?.width ?? 0)
			.toBeGreaterThanOrEqual(160);
		const collapsedWidth = await row.evaluate((element) => {
			const button = element.querySelector<HTMLElement>("[data-task-id]");
			const chip = element.querySelector<HTMLElement>(
				'[data-testid="reminder-chip"]',
			);
			const title = element.querySelector<HTMLElement>("[data-reading-title]");
			if (!button?.parentElement || !chip || !title)
				throw new Error("missing regression control");
			const group = button.parentElement;
			const saved = [
				button.style.cssText,
				group.style.cssText,
				chip.style.cssText,
			];
			try {
				group.style.display = "contents";
				button.style.minWidth = "0";
				button.style.flex = "1 1 0%";
				chip.style.maxWidth = "none";
				return title.getBoundingClientRect().width;
			} finally {
				[button.style.cssText, group.style.cssText, chip.style.cssText] = saved;
			}
		});
		expect(
			collapsedWidth,
			"the original row layout reproduces the narrow title",
		).toBeLessThan(160);
		const titleBox = await title.boundingBox();
		const chipBox = await chip.boundingBox();
		const rowBox = await row.boundingBox();
		if (!titleBox || !chipBox || !rowBox) throw new Error("missing row bounds");
		expect(chipBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
		expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(
			rowBox.x + rowBox.width,
		);
	} finally {
		await pool.end();
	}
});

test("the first-run banner gives its paragraph the phone width above its actions", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await signUp(page, uniqueEmail("setup-width"));
	const banner = page.getByRole("complementary", { name: "Set up your space" });
	await expect(banner).toBeVisible();
	const paragraph = await banner.locator("p").boundingBox();
	const action = await banner
		.getByRole("button", { name: "Choose starter content" })
		.boundingBox();
	if (!paragraph || !action) throw new Error("missing banner bounds");
	const collapsedWidth = await banner.locator("p").evaluate((element) => {
		const saved = element.style.cssText;
		try {
			element.style.flex = "1 1 0%";
			return element.getBoundingClientRect().width;
		} finally {
			element.style.cssText = saved;
		}
	});
	expect(
		collapsedWidth,
		"the original flex layout squeezes the paragraph",
	).toBeLessThan(150);
	expect(paragraph.width).toBeGreaterThanOrEqual(300);
	expect(action.y).toBeGreaterThanOrEqual(paragraph.y + paragraph.height);
});
