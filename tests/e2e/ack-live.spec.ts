import { expect, type Locator, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import { parseAckUrl } from "../support/ntfy-tap.ts";

// M3a Task 16 e2e: the live half of the durability gate.
//
// What only this file can close:
//  - a real ntfy tap receives the notification and its action URL works (11/12);
//  - an OPEN Zero client observes the ack and the completion over the live sync
//    transport, with no navigation (13) -- the gate Spike B could not close;
//  - a second open client observes SIBLING termination (14, C7): the design's
//    claim is not "no further outbox rows", it is that a co-assignee's client
//    goes terminal too;
//  - an assignment driven through the mounted /api/zero/mutate route produces
//    its notification (15, X0). events.run/events.flush in src/server/index.ts
//    are unreachable from the in-process integration suite, so deleting either
//    call site is only caught here.
//
// The ack is exercised on a habits-kind list (C22): completeForAck branches on
// list kind and the habit branch is the one that broke.
test.describe.configure({ timeout: 120_000 });

const SHARED_WORKSPACE_ID = "w_shared_e2e";
const PASSWORD = "pw-123456";
const SIGNUP_TIMEOUT = 30_000;
// Set by playwright.config: a private non-loopback address, since the SSRF
// boundary refuses loopback unconditionally.
const NTFY = process.env.E2E_NTFY_URL ?? "http://172.17.0.1:4599";

type Captured = {
	topic: string;
	title: string;
	body: string;
	actions: string | null;
};

let seq = 0;
function unique(prefix: string): string {
	seq += 1;
	return `${prefix}-${Date.now()}-${seq}`;
}

async function signUp(page: Page, email: string): Promise<string> {
	await page.goto("/");
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill(PASSWORD);
	await page.getByTestId("signup").click();
	await expect(page.getByTestId("workspace")).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
	const session = await page.evaluate(async () => {
		const response = await fetch("/api/auth/get-session");
		return (await response.json()) as { user: { id: string } };
	});
	return session.user.id;
}

async function joinShared(
	userId: string,
	role: "owner" | "member" = "member",
): Promise<void> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await pool.query(
			`insert into membership (id, user_id, workspace_id, role) values ($1,$2,$3,$4)`,
			[crypto.randomUUID(), userId, SHARED_WORKSPACE_ID, role],
		);
	} finally {
		await pool.end();
	}
}

async function waitWorkspaceReady(page: Page): Promise<void> {
	await expect(page.getByRole("button", { name: /'s space/ })).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
}

// Configure this account's ntfy channel at its own topic, so the tap can be
// read per recipient.
async function configureNtfy(page: Page, topic: string): Promise<void> {
	await expect(page.getByTestId("notification-settings")).toBeVisible({
		timeout: 15_000,
	});
	// M3b Task 15 replaced the single-channel surface with the five-row
	// ChannelRow; the ntfy form now lives behind the collapsed row's disclosure
	// and its fields moved under the channel-ntfy-* prefix.
	if (!(await page.getByTestId("channel-ntfy-serverUrl").count())) {
		await page.getByTestId("channel-ntfy-disclosure").click();
	}
	await page.getByTestId("channel-ntfy-serverUrl").fill(NTFY);
	await page.getByTestId("channel-ntfy-topic").fill(topic);
	await page.getByTestId("channel-ntfy-save").click();
	await expect(page.getByTestId("channel-ntfy-toggle")).toHaveAttribute(
		"aria-checked",
		"true",
		{ timeout: 15_000 },
	);
}

async function captured(page: Page, topic: string): Promise<Captured[]> {
	const response = await page.request.get(
		`${NTFY}/_captured?topic=${encodeURIComponent(topic)}`,
	);
	return (await response.json()) as Captured[];
}

async function waitForNotification(
	page: Page,
	topic: string,
	match: (row: Captured) => boolean,
	timeoutMs = 60_000,
): Promise<Captured> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const rows = (await captured(page, topic)).filter(match);
		if (rows.length > 0) return rows[0];
		if (Date.now() > deadline) {
			throw new Error(`no matching notification on topic ${topic}`);
		}
		await page.waitForTimeout(500);
	}
}

// The scheduler expands in the list owner's stored zone, which the client
// detects and writes on load -- so the fixture is built in that zone, not UTC.
async function localNowMinus(page: Page, minutes: number) {
	return await page.evaluate((mins) => {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const at = new Date(Date.now() - mins * 60_000);
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: zone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}).formatToParts(at);
		const get = (type: string) =>
			parts.find((p) => p.type === type)?.value ?? "00";
		return {
			date: `${get("year")}-${get("month")}-${get("day")}`,
			time: `${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}`,
		};
	}, minutes);
}

function sidebarLists(page: Page): Locator {
	return page.getByRole("navigation", { name: "Lists" });
}

// A list in the seeded shared workspace owned by `ownerId`, so the reminder
// scan expands it in that user's stored timezone.
async function seedSharedList(ownerId: string, title: string): Promise<string> {
	const id = crypto.randomUUID();
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await pool.query(
			`insert into list (id, workspace_id, owner_id, title, kind, sort_key)
			 values ($1, $2, $3, $4, 'tasks', 'a5')`,
			[id, SHARED_WORKSPACE_ID, ownerId, title],
		);
	} finally {
		await pool.end();
	}
	return id;
}

// The seeded shared workspace outlives this file (global-setup seeds once) and
// every later spec asserts against it, so the list this test adds -- and its
// completed task and memberships -- must not survive the run.
//
// This is load-bearing rather than tidy: `ack-live` sorts FIRST alphabetically
// and playwright.config pins `workers: 1`, so anything left behind is visible
// to the entire rest of the suite. Dropping this cleanup was observed to fail
// two domain.spec tests.
async function restoreSharedWorkspace(
	listId: string | null,
	userIds: string[],
): Promise<void> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		if (listId) {
			await pool.query(
				`delete from task_assignee where task_id in (select id from task where list_id = $1)`,
				[listId],
			);
			// reminder_state -> notification_outbox -> ack_capability all cascade
			// from the task.
			await pool.query(`delete from task where list_id = $1`, [listId]);
			await pool.query(`delete from list where id = $1`, [listId]);
		}
		if (userIds.length > 0) {
			await pool.query(
				`delete from membership where workspace_id = $1 and user_id = any($2)`,
				[SHARED_WORKSPACE_ID, userIds],
			);
		}
	} finally {
		await pool.end();
	}
}

async function openList(page: Page, title: string): Promise<void> {
	await sidebarLists(page)
		.getByRole("button", { name: title, exact: true })
		.last()
		.click();
	await expect(page.getByTestId("list")).toBeVisible({ timeout: 15_000 });
}

async function openDetail(page: Page, title: string): Promise<Locator> {
	await page
		.locator("[data-kbd-nav]")
		.filter({ hasText: title })
		.first()
		.click();
	// Named, not the bare role: the assignee picker is a dialog too, so the bare
	// role is ambiguous once it has been opened on this page.
	const detail = page.getByRole("dialog", { name: "Task details" });
	await expect(detail.getByLabel("Task title")).toBeVisible();
	return detail;
}

async function setReminder(page: Page, title: string): Promise<void> {
	const detail = await openDetail(page, title);
	const when = await localNowMinus(page, 2);
	await detail.getByLabel("Due date").fill(when.date);
	await detail.getByTestId("reminder-time").fill(when.time);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Task details" })).toBeHidden({
		timeout: 15_000,
	});
}

// Marks the live document. Any navigation or reload resets it, which is how
// "the open client observed this" is made mechanically checkable (X8).
async function markLiveDocument(page: Page): Promise<void> {
	await page.evaluate(() => {
		(window as unknown as { __ackLiveMarker?: number }).__ackLiveMarker =
			Date.now();
	});
}

async function expectSameDocument(page: Page, since: string): Promise<void> {
	const marker = await page.evaluate(
		() => (window as unknown as { __ackLiveMarker?: number }).__ackLiveMarker,
	);
	expect(marker, "the page must not have navigated or reloaded").toBeDefined();
	expect(page.url()).toBe(since);
}

test("live ack: a real tap's action URL acks a habit and the open client sees it", async ({
	page,
}) => {
	const topic = unique("acklive");
	await signUp(page, `${topic}@t.dev`);
	await waitWorkspaceReady(page);
	await configureNtfy(page, topic);

	// habits kind is not in the blank-list picker; the starter template is the
	// create path (mirrors habits.spec / notifications.spec).
	await page.getByRole("combobox", { name: "Start from template" }).click();
	await page.getByRole("option", { name: "Habits", exact: true }).click();
	await page.getByTestId("new-list-submit").click();
	await sidebarLists(page)
		.getByRole("button", { name: "Habits", exact: true })
		.last()
		.click();
	await expect(page.getByTestId("list")).toBeVisible({ timeout: 15_000 });

	const HABIT = "Drink water";
	await setReminder(page, HABIT);

	// 11: the notification reaches a real tap, carrying a working action URL.
	const delivery = await waitForNotification(
		page,
		topic,
		(row) => row.title === HABIT && parseAckUrl(row.actions) !== null,
	);
	const ackUrl = parseAckUrl(delivery.actions);
	expect(ackUrl).not.toBeNull();
	expect(ackUrl).toContain("/api/notifications/ack/");

	// 13: assert from the already-open client, with no navigation. The marker
	// and the URL are the mechanical check that nothing re-fetched the document.
	const chip = page.getByTestId("reminder-chip").first();
	await expect(chip).toBeVisible({ timeout: 45_000 });
	await expect(chip).toContainText("Reminder set");
	const url = page.url();
	await markLiveDocument(page);

	// 12: POSTing the URL from outside the app acks it. Same call ntfy's action
	// button makes -- no session, no cookie.
	const acked = await page.request.post(ackUrl as string);
	expect(acked.status()).toBe(200);

	// Bounded window: the ack has to arrive over the live sync transport.
	await expect(chip).toContainText("Acknowledged", { timeout: 30_000 });
	// C22: the habit branch logged today's occurrence rather than completing a
	// task.
	await expect(
		page
			.getByTestId("habit-card")
			.filter({ hasText: HABIT })
			.getByTestId("habit-done"),
	).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
	await expectSameDocument(page, url);

	// The capability is single-use: a replay of the same URL is refused.
	const replay = await page.request.post(ackUrl as string);
	expect(replay.status()).toBe(400);
});

test("live ack: assignment notifies through /api/zero/mutate, and one ack terminates the sibling", async ({
	browser,
}) => {
	const a = await browser.newContext();
	const b = await browser.newContext();
	const pa = await a.newPage();
	const pb = await b.newPage();
	let listId: string | null = null;
	const joined: string[] = [];
	try {
		const topicA = unique("ackowner");
		const topicB = unique("ackmember");
		const ownerId = await signUp(pa, `${topicA}@t.dev`);
		await joinShared(ownerId, "owner");
		joined.push(ownerId);
		const memberId = await signUp(pb, `${topicB}@t.dev`);
		await joinShared(memberId, "member");
		joined.push(memberId);
		const memberName = `${topicB}`;

		await waitWorkspaceReady(pa);
		await configureNtfy(pa, topicA);
		await waitWorkspaceReady(pb);
		await configureNtfy(pb, topicB);

		// The reminder scan expands in the LIST OWNER's stored zone. The seeded
		// shared list is owned by the system user, which has no user_pref, so a
		// reminder built in the browser's zone would land hours outside the grace
		// window and never fire. Give the shared workspace a list this owner owns.
		const LIST = unique("Shared");
		listId = await seedSharedList(ownerId, LIST);

		await pa.getByTestId("open-shared").click();
		await expect(pa.getByTestId("new-task")).toBeVisible({ timeout: 15_000 });
		await pb.getByTestId("open-shared").click();
		await expect(pb.getByTestId("new-task")).toBeVisible({ timeout: 15_000 });
		await openList(pa, LIST);
		await openList(pb, LIST);

		const TASK = unique("Shared reminder");
		await pa.getByTestId("new-task").fill(TASK);
		await pa.getByTestId("new-task-submit").click();
		await expect(
			pa.getByTestId("list").getByText(TASK, { exact: true }),
		).toBeVisible({ timeout: 15_000 });

		// 15 / X0: the assignment goes through the real /api/zero/mutate route.
		// Its notification exists only because index.ts wraps the handler in
		// events.run and calls events.flush afterwards -- delete either and this
		// wait times out.
		const detail = await openDetail(pa, TASK);
		await pa.getByTestId("assignee-open").click();
		await expect(pa.getByTestId("assignee-picker")).toBeVisible();
		for (const name of [memberName, topicA]) {
			await pa
				.getByTestId("assignee-picker")
				.locator('[data-testid="assignee-option"]')
				.filter({ hasText: name })
				.first()
				.click();
		}
		await expect(pa.getByTestId("assignee-open")).toContainText(
			"Assignees (2)",
		);
		// First Escape dismisses the picker popover, second the detail sheet.
		await pa.keyboard.press("Escape");
		await expect(pa.getByTestId("assignee-picker")).toBeHidden();
		await pa.keyboard.press("Escape");
		await expect(detail).toBeHidden({ timeout: 15_000 });

		await waitForNotification(
			pa,
			topicB,
			(row) =>
				row.title === TASK && row.body.includes("You were assigned this task"),
		);

		// Both assignees are reminder recipients, so the scan creates two sibling
		// reminder_state rows on one occurrence.
		await setReminder(pa, TASK);

		// Both clients must be showing a LIVE reminder before the ack, or the
		// vanish asserted below proves nothing.
		await expect(pa.getByTestId("reminder-chip").first()).toBeVisible({
			timeout: 60_000,
		});
		await expect(pb.getByTestId("reminder-chip").first()).toBeVisible({
			timeout: 60_000,
		});

		const delivery = await waitForNotification(
			pa,
			topicA,
			(row) => row.title === TASK && parseAckUrl(row.actions) !== null,
		);
		const ackUrl = parseAckUrl(delivery.actions);
		expect(ackUrl).not.toBeNull();

		const urlB = pb.url();
		await markLiveDocument(pb);
		const acked = await pa.request.post(ackUrl as string);
		expect(acked.status()).toBe(200);

		// 14 / C7: the OTHER assignee's open client sees the completion AND its
		// own sibling reminder go terminal. ReminderChip retires only on
		// `task.done && current.status === "acked"` -- `current` is the viewer's
		// OWN reminder_state row -- so on a done task a chip that is still
		// rendered is a sibling that was never terminated. Both halves are
		// asserted so a vanished chip cannot be mistaken for a vanished row.
		//
		// (On a habits list the chip goes to "Acknowledged" instead; that path is
		// the first test.)
		const checkboxB = pb.getByRole("checkbox", { name: TASK });
		await expect(checkboxB).toHaveAttribute("aria-checked", "true", {
			timeout: 60_000,
		});
		await expect(pb.getByTestId("reminder-chip")).toHaveCount(0, {
			timeout: 60_000,
		});
		await expectSameDocument(pb, urlB);

		// The acking user's own client, for completeness.
		await expect(pa.getByRole("checkbox", { name: TASK })).toHaveAttribute(
			"aria-checked",
			"true",
			{ timeout: 60_000 },
		);
		await expect(pa.getByTestId("reminder-chip")).toHaveCount(0, {
			timeout: 60_000,
		});
	} finally {
		await a.close();
		await b.close();
		// The seeded shared workspace outlives this file and every later spec
		// asserts against it; leave it exactly as found.
		await restoreSharedWorkspace(listId, joined);
	}
});
