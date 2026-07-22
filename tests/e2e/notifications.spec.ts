import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

// M3a Task 15 e2e: the notification settings surface (channel config, masked
// secret round-trip, test send, quiet hours), the per-task reminder policy, and
// the in-app ack on a habits-kind list (S4 -- the C22 habit-ack bug ships again
// if the in-app path is only ever exercised on a tasks list). Conventions
// (signUp/uniqueEmail/testid locators/frozen-frame axe) mirror habits.spec.
test.describe.configure({ retries: 2, timeout: 90_000 });

const PASSWORD = "pw-123456";
const SIGNUP_TIMEOUT = 30_000;
// Set by playwright.config: a private, non-loopback address, since the SSRF
// boundary refuses loopback unconditionally.
const NTFY = process.env.E2E_NTFY_URL ?? "http://172.17.0.1:4599";
const TOKEN = "tk_e2e_secret_value";

let emailSeq = 0;
function uniqueEmail(prefix: string): string {
	emailSeq += 1;
	return `${prefix}-${Date.now()}-${emailSeq}@t.dev`;
}

async function signUp(page: Page, email: string): Promise<void> {
	await page.goto("/");
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill(PASSWORD);
	await page.getByTestId("signup").click();
	await expect(page.getByTestId("workspace")).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
}

function sidebarLists(page: Page): Locator {
	return page.getByRole("navigation", { name: "Lists" });
}

async function waitWorkspaceReady(page: Page): Promise<void> {
	await expect(page.getByRole("button", { name: /'s space/ })).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
}

async function settings(page: Page): Promise<Locator> {
	const panel = page.getByTestId("notification-settings");
	await expect(panel).toBeVisible({ timeout: 15_000 });
	return panel;
}

async function fillNtfy(
	page: Page,
	topic: string,
	token?: string,
): Promise<void> {
	// The config form is behind the row's enabled toggle until a row exists.
	if (!(await page.getByTestId("ntfy-server-url").count())) {
		await page.getByTestId("channel-ntfy-toggle").click();
	}
	await page.getByTestId("ntfy-server-url").fill(NTFY);
	await page.getByTestId("ntfy-topic").fill(topic);
	if (token !== undefined) await page.getByTestId("ntfy-token").fill(token);
}

async function expectNoSeriousA11y(page: Page, surface: string): Promise<void> {
	await page.addStyleTag({
		content:
			"*,*::before,*::after{animation:none!important;transition:none!important}",
	});
	const { violations } = await new AxeBuilder({ page }).analyze();
	const serious = violations.filter(
		(v) => v.impact === "serious" || v.impact === "critical",
	);
	expect(serious.map((v) => `${surface}: ${v.id} (${v.nodes.length})`)).toEqual(
		[],
	);
}

test.describe("notification settings", () => {
	test.beforeEach(async ({ page }) => {
		await signUp(page, uniqueEmail("notif"));
		await waitWorkspaceReady(page);
	});

	test("configures an ntfy channel and reopens it with the secret masked", async ({
		page,
	}) => {
		await settings(page);
		await fillNtfy(page, "e2e-alerts", TOKEN);
		await page.getByTestId("ntfy-save").click();
		await expect(page.getByTestId("channel-ntfy-toggle")).toHaveAttribute(
			"aria-checked",
			"true",
			{ timeout: 15_000 },
		);

		// The stored secret must never come back: the form rehydrates from the
		// masked server view.
		await page.reload();
		await waitWorkspaceReady(page);
		await settings(page);
		await expect(page.getByTestId("ntfy-server-url")).toHaveValue(NTFY, {
			timeout: 15_000,
		});
		await expect(page.getByTestId("ntfy-token")).toHaveValue("***");
		expect(await page.content()).not.toContain(TOKEN);
	});

	test("saving without retyping the secret preserves it", async ({ page }) => {
		await settings(page);
		await fillNtfy(page, "e2e-keep-1", TOKEN);
		await page.getByTestId("ntfy-save").click();
		await expect(page.getByTestId("channel-ntfy-toggle")).toHaveAttribute(
			"aria-checked",
			"true",
			{ timeout: 15_000 },
		);

		await page.reload();
		await waitWorkspaceReady(page);
		await settings(page);
		await expect(page.getByTestId("ntfy-token")).toHaveValue("***", {
			timeout: 15_000,
		});
		// Change only the topic, leave "***" in place, then prove the preserved
		// secret still works by sending with it. The stub rejects this topic
		// family without the exact bearer token, so a restore that silently
		// dropped the secret fails here instead of passing on a 200.
		await page.getByTestId("ntfy-topic").fill("e2e-keep-2");
		await page.getByTestId("ntfy-save").click();
		await page.getByTestId("ntfy-test").click();
		await expect(page.getByTestId("ntfy-test-result")).toContainText(
			"Verified",
			{ timeout: 20_000 },
		);
	});

	test("a successful test send marks the channel verified", async ({
		page,
	}) => {
		await settings(page);
		await fillNtfy(page, "e2e-verify", TOKEN);
		await page.getByTestId("ntfy-test").click();
		await expect(page.getByTestId("ntfy-test-result")).toContainText(
			"Verified",
			{ timeout: 20_000 },
		);

		await page.reload();
		await waitWorkspaceReady(page);
		await settings(page);
		await expect(page.getByTestId("ntfy-test-result")).toContainText(
			"Verified",
			{ timeout: 20_000 },
		);
	});

	test("a failed test send shows a redacted reason with no token", async ({
		page,
	}) => {
		await settings(page);
		// The stub answers 401 on this topic.
		await fillNtfy(page, "reject-me", TOKEN);
		await page.getByTestId("ntfy-test").click();
		const result = page.getByTestId("ntfy-test-result");
		await expect(result).toContainText("Server rejected the request", {
			timeout: 20_000,
		});
		await expect(result).not.toContainText("Verified");
		// The reason is the surface under test; the token itself is legitimately
		// still in the field the user just typed into (test 1 covers the
		// post-reload case, where it must be gone).
		const text = (await result.textContent()) ?? "";
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain(new URL(NTFY).hostname);
	});

	test("quiet hours save and display the user's timezone", async ({ page }) => {
		const panel = await settings(page);
		await page.getByTestId("quiet-start").fill("22:00");
		await page.getByTestId("quiet-end").fill("07:00");
		await expect(panel.getByTestId("quiet-tz")).toContainText(/UTC|\//, {
			timeout: 15_000,
		});

		await page.reload();
		await waitWorkspaceReady(page);
		await settings(page);
		await expect(page.getByTestId("quiet-start")).toHaveValue("22:00", {
			timeout: 15_000,
		});
		await expect(page.getByTestId("quiet-end")).toHaveValue("07:00");
		await expect(page.getByTestId("quiet-urgent-note")).toContainText(
			"ignore quiet hours",
		);
	});

	test("axe: settings page", async ({ page }) => {
		await settings(page);
		await fillNtfy(page, "e2e-axe", TOKEN);
		await page.getByTestId("ntfy-save").click();
		await expect(page.getByTestId("channel-ntfy-toggle")).toHaveAttribute(
			"aria-checked",
			"true",
			{ timeout: 15_000 },
		);
		await expectNoSeriousA11y(page, "notification settings");
	});

	test("mobile renders the settings surface in one column", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.getByRole("button", { name: "Settings" }).click();
		const panel = await settings(page);
		await expect(panel.getByTestId("channel-ntfy")).toBeVisible();
		await expect(panel.getByTestId("channel-telegram")).toHaveAttribute(
			"aria-disabled",
			"true",
		);
		await expect(panel.getByTestId("quiet-hours")).toBeVisible();
		// No horizontal overflow at a phone width.
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth + 1,
		);
		expect(overflow).toBe(false);
		await expectNoSeriousA11y(page, "notification settings (mobile)");
	});
});

test.describe("per-task reminder policy and in-app ack", () => {
	async function createList(page: Page, name: string) {
		await waitWorkspaceReady(page);
		await page.getByTestId("new-list").fill(name);
		await page.getByTestId("new-list-submit").click();
		await expect(
			sidebarLists(page).getByRole("button", { name, exact: true }).first(),
		).toBeVisible({ timeout: 15_000 });
		await openList(page, name);
	}

	// habits kind is not in the blank-list picker; the starter template is the
	// create path (mirrors habits.spec).
	async function createHabitsList(page: Page) {
		await waitWorkspaceReady(page);
		await page.getByRole("combobox", { name: "Start from template" }).click();
		await page.getByRole("option", { name: "Habits", exact: true }).click();
		await page.getByTestId("new-list-submit").click();
		await expect(
			sidebarLists(page)
				.getByRole("button", { name: "Habits", exact: true })
				.first(),
		).toBeVisible({ timeout: 15_000 });
		await openList(page, "Habits");
	}

	async function openList(page: Page, name: string) {
		await sidebarLists(page)
			.getByRole("button", { name, exact: true })
			.last()
			.click();
		await expect(page.getByTestId("list")).toBeVisible({ timeout: 15_000 });
	}

	async function addTask(page: Page, title: string) {
		await page.getByTestId("new-task").fill(title);
		await page.getByTestId("new-task-submit").click();
		await expect(
			page.getByTestId("list").getByText(title, { exact: true }),
		).toBeVisible({ timeout: 15_000 });
	}

	async function openDetail(page: Page, title: string): Promise<Locator> {
		await page
			.locator("[data-kbd-nav]")
			.filter({ hasText: title })
			.first()
			.click();
		const detail = page.getByRole("dialog");
		await expect(detail.getByLabel("Task title")).toBeVisible();
		return detail;
	}

	// The scheduler expands in the list owner's stored zone, which the client
	// detects and writes on load -- so the fixture has to be built in that same
	// zone, not in UTC.
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

	test("saves a reminder time and the urgent toggle", async ({ page }) => {
		await signUp(page, uniqueEmail("policy"));
		await createList(page, "Meds");
		await addTask(page, "Take pills");
		const detail = await openDetail(page, "Take pills");

		await detail.getByLabel("Due date").fill("2026-09-01");
		await detail.getByTestId("reminder-time").fill("08:30");
		await detail.getByTestId("reminder-urgent").click();
		await expect(detail.getByTestId("reminder-urgent")).toHaveAttribute(
			"aria-checked",
			"true",
		);

		await detail.getByTestId("reminder-overrides-toggle").click();
		await detail.getByTestId("reminder-repeat").fill("15");
		await detail.getByTestId("reminder-max").fill("2");
		await expectNoSeriousA11y(page, "reminder policy");

		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toBeHidden({ timeout: 15_000 });
		const reopened = await openDetail(page, "Take pills");
		await expect(reopened.getByTestId("reminder-time")).toHaveValue("08:30");
		await expect(reopened.getByTestId("reminder-urgent")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await expect(reopened.getByTestId("reminder-repeat")).toHaveValue("15");
		await expect(reopened.getByTestId("reminder-max")).toHaveValue("2");
	});

	// S4: completeForAck branches on list kind, and the habit branch is the one
	// the C22 bug broke. Driven through the real scheduler (tick tuned down in
	// playwright.config) rather than a seeded row, so the whole chain is under
	// test.
	test("a pending reminder on a habits list renders and acks in-app", async ({
		page,
	}) => {
		await signUp(page, uniqueEmail("ack"));
		await createHabitsList(page);

		const HABIT = "Drink water";
		const detail = await openDetail(page, HABIT);
		const when = await localNowMinus(page, 2);
		await detail.getByLabel("Due date").fill(when.date);
		await detail.getByTestId("reminder-time").fill(when.time);
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toBeHidden({ timeout: 15_000 });

		// The scan tick materializes the reminder_state row, which syncs back.
		const chip = page.getByTestId("reminder-chip").first();
		await expect(chip).toBeVisible({ timeout: 45_000 });
		await expect(chip).toContainText("Reminder set");
		await expectNoSeriousA11y(page, "reminder chip");

		await chip.click();
		// Terminal, so the chip becomes a static label rather than disappearing
		// (the chip only vanishes once the task itself is complete, shell doc 5).
		await expect(chip).toContainText("Acknowledged", { timeout: 20_000 });

		// The habit branch logged today's occurrence rather than completing a
		// task -- this is the C22 regression guard.
		await expect(
			page
				.getByTestId("habit-card")
				.filter({ hasText: HABIT })
				.getByTestId("habit-done"),
		).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
	});
});
