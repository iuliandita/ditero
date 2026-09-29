import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import {
	chooseOption,
	goToSettings,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

const NTFY = process.env.E2E_NTFY_URL ?? "http://172.17.0.1:4599";

async function openSettings(page: Page, prefix: string) {
	await signUp(page, uniqueEmail(prefix));
	await waitWorkspaceReady(page);
	await goToSettings(page);
}

test("sections read in a fixed order with the danger zone last", async ({
	page,
}) => {
	await openSettings(page, "settings-order");
	const sections = page.getByTestId("settings-section");
	await expect(sections).toHaveCount(9);
	expect(
		await sections.evaluateAll((els) =>
			els.map((el) => (el as HTMLElement).dataset.section),
		),
	).toEqual([
		"account",
		"appearance",
		"notifications",
		"security",
		"lists",
		"focus",
		"keyboard",
		"data",
		"danger",
	]);

	// Delete account sits alone in the last section, after export and import.
	const danger = sections.last();
	await expect(danger.getByTestId("delete-account-open")).toBeVisible();
	const data = page.locator('[data-section="data"]');
	await expect(
		data.getByRole("button", { name: "Download JSON" }),
	).toBeVisible();
	await expect(data.locator("#import-plan")).toBeVisible();
	await expect(data.getByTestId("delete-account-open")).toHaveCount(0);

	// No empty band or divider above the first section.
	expect(
		await sections
			.first()
			.evaluate((el) => getComputedStyle(el).borderTopWidth),
	).toBe("0px");
	await expect(sections.nth(1)).toHaveCSS("border-top-width", "1px");

	// The desktop section nav lands focus on the heading it names.
	const nav = page.getByTestId("settings-nav");
	await expect(nav.locator("a")).toHaveCount(9);
	await nav.getByText("Danger zone", { exact: true }).click();
	await expect(page.locator("#settings-danger-heading")).toBeFocused();

	await page.addStyleTag({
		content:
			"*,*::before,*::after{animation:none!important;transition:none!important}",
	});
	const { violations } = await new AxeBuilder({ page })
		.include('[data-testid="settings-surface"]')
		.analyze();
	const serious = violations.filter(
		(v) => v.impact === "serious" || v.impact === "critical",
	);
	expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
});

test("unconfigured channels start collapsed with one Set up action", async ({
	page,
}) => {
	await openSettings(page, "settings-channels");
	for (const kind of ["ntfy", "telegram", "discord", "slack"]) {
		const row = page.getByTestId(`channel-${kind}`);
		await expect(row).toBeVisible();
		await expect(row.getByTestId(`channel-${kind}-form`)).toHaveCount(0);
		await expect(row.getByTestId(`channel-${kind}-disclosure`)).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		// One action: no separate switch until something is stored.
		await expect(row.getByTestId(`channel-${kind}-toggle`)).toHaveCount(0);
		await expect(row.getByTestId(`channel-${kind}-action`)).toHaveText(
			"Set up",
		);
	}

	await page.getByTestId("channel-ntfy-disclosure").click();
	await expect(page.getByTestId("channel-ntfy-form")).toBeVisible();
	await expect(page.getByTestId("channel-ntfy-action")).toHaveCount(0);
	await page.getByTestId("channel-ntfy-serverUrl").fill(NTFY);
	await page.getByTestId("channel-ntfy-topic").fill("settings-e2e");
	await page.getByTestId("channel-ntfy-save").click();
	await expect(page.getByTestId("channel-ntfy-toggle")).toHaveAttribute(
		"aria-checked",
		"true",
		{ timeout: 15_000 },
	);

	// Configured: collapsed again, it offers Edit beside its switch.
	await page.getByTestId("channel-ntfy-disclosure").click();
	await expect(page.getByTestId("channel-ntfy-form")).toHaveCount(0);
	await expect(page.getByTestId("channel-ntfy-action")).toHaveText("Edit");
	await expect(page.getByTestId("channel-telegram-action")).toHaveText(
		"Set up",
	);
});

test("quiet hours keep their wall-clock times in a non-UTC zone", async ({
	page,
}) => {
	await openSettings(page, "settings-quiet-zone");
	const session = await page.evaluate(async () => {
		const response = await fetch("/api/auth/get-session");
		return (await response.json()) as { user: { id: string } };
	});

	// The zone link lands on the zone control.
	await page.getByTestId("quiet-tz-change").click();
	await expect(page.getByTestId("timezone-select")).toBeFocused();

	await chooseOption(
		page,
		page.getByTestId("timezone-select"),
		"Europe/Berlin",
	);
	await expect(page.getByTestId("quiet-zone")).toHaveText("Europe/Berlin", {
		timeout: 15_000,
	});

	await page.getByTestId("quiet-start").fill("22:00");
	await page.getByTestId("quiet-start").press("Enter");
	await page.getByTestId("quiet-end").fill("7am");
	await page.getByTestId("quiet-end").press("Enter");
	await expect(page.getByTestId("quiet-save-status")).toHaveText("Saved", {
		timeout: 15_000,
	});

	await page.reload();
	await waitWorkspaceReady(page);
	await goToSettings(page);
	await expect(page.getByTestId("quiet-start")).toHaveValue(/^10:00\sPM$/, {
		timeout: 15_000,
	});
	await expect(page.getByTestId("quiet-end")).toHaveValue(/^7:00\sAM$/);
	await expect(page.getByTestId("quiet-zone")).toHaveText("Europe/Berlin");
	await expect(page.getByTestId("quiet-tz")).toContainText("Europe/Berlin");

	// Stored exactly as typed, beside the zone the server reads them in
	// (tests/integration/scheduler.test.ts pins that reading).
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		const { rows } = await pool.query<{
			timezone: string;
			quiet_hours: unknown;
		}>("select timezone, quiet_hours from user_pref where id = $1", [
			session.user.id,
		]);
		expect(rows[0]).toEqual({
			timezone: "Europe/Berlin",
			quiet_hours: { start: "22:00", end: "07:00" },
		});
	} finally {
		await pool.end();
	}
});

test("the import file picker is on-system and keyboard reachable", async ({
	page,
}) => {
	await openSettings(page, "settings-file");
	const panel = page.getByRole("region", { name: "Plan an import" });
	await expect(panel.getByTestId("import-file-name")).toHaveText(
		"No file chosen",
	);
	const input = panel.getByLabel("Native JSON export");
	await expect(input).toHaveAttribute("type", "file");
	// The native control is visually hidden, not removed.
	await expect(input).toHaveClass(/sr-only/);

	// Keyboard: the next tab stop after Download JSON is the file input, and
	// Space opens the chooser from it.
	await page.getByRole("button", { name: "Download JSON" }).focus();
	await page.keyboard.press("Tab");
	await expect(input).toBeFocused();
	const chooser = page.waitForEvent("filechooser");
	await page.keyboard.press("Space");
	await (await chooser).setFiles({
		name: "family-export.json",
		mimeType: "application/json",
		buffer: Buffer.from("{}"),
	});
	await expect(panel.getByTestId("import-file-name")).toHaveText(
		"family-export.json",
	);
	// Not a native export, so it is refused with a reason, not silently.
	await expect(panel.getByRole("alert")).toBeVisible({ timeout: 15_000 });
});
