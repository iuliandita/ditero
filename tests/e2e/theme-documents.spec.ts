import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { BUILTIN_THEME_DOCUMENTS } from "../../src/domain/theme-document.ts";
import { goToSettings, signUp, uniqueEmail } from "./helpers.ts";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test("named palettes follow mode and keep task colors and contrast controls", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("theme-palettes"));
	await goToSettings(page);
	await page.getByTestId("theme-switcher").click();
	await page.getByRole("option", { name: "Light", exact: true }).click();
	const semantics = () =>
		page.evaluate(() => {
			const style = getComputedStyle(document.documentElement);
			return [
				"--priority-3",
				"--kind-shopping",
				"--success",
				"--destructive",
			].map((token) => style.getPropertyValue(token));
		});
	const before = await semantics();
	await page.getByTestId("named-theme-select").selectOption("paper");
	await expect
		.poll(() =>
			page.evaluate(() =>
				Object.entries(localStorage).some(
					([key, raw]) =>
						key.startsWith("ditero.themes.") &&
						JSON.parse(raw).selected === "paper",
				),
			),
		)
		.toBe(true);
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(250, 247, 240)",
	);
	expect(await semantics()).toEqual(before);
	await page.getByTestId("display-size-large").check();
	await page.getByTestId("display-high-contrast").click();
	await expect(page.locator("html")).toHaveAttribute(
		"data-high-contrast",
		"true",
	);
	await expect(page.locator("html")).toHaveAttribute(
		"data-reading-size",
		"large",
	);
	await page.getByTestId("theme-switcher").click();
	await page.getByRole("option", { name: "Dark", exact: true }).click();
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(33, 31, 27)",
	);
	await page.getByTestId("display-high-contrast").click();
	await page.getByTestId("display-accent-blue").check();
	await expect(page.locator("html")).toHaveCSS("--primary", "#6FA0F0");
	await page.reload();
	await goToSettings(page);
	await expect(page.getByTestId("named-theme-select")).toHaveValue("paper");
});

test("theme import exports validated colors, rejects unsafe files and isolates accounts", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("theme-import"));
	await goToSettings(page);
	const theme = { ...BUILTIN_THEME_DOCUMENTS.slate, name: "My palette" };
	await page.getByTestId("named-theme-import").setInputFiles({
		name: "theme.json",
		mimeType: "application/json",
		buffer: Buffer.from(JSON.stringify(theme)),
	});
	await expect(page.getByTestId("named-theme-select")).toHaveValue(/.+/);
	await expect(
		page.getByTestId("named-theme-select").locator("option:checked"),
	).toHaveText("My palette");
	const selected = await page.getByTestId("named-theme-select").inputValue();
	const download = page.waitForEvent("download");
	await page
		.getByRole("button", { name: "Export theme JSON", exact: true })
		.click();
	expect((await download).suggestedFilename()).toBe("ditero-theme.json");
	await page.getByTestId("named-theme-import").setInputFiles({
		name: "unsafe.json",
		mimeType: "application/json",
		buffer: Buffer.from(
			JSON.stringify({
				...theme,
				light: { ...theme.light, background: "url(https://example.test)" },
			}),
		),
	});
	await expect(page.getByRole("alert")).toContainText("Theme import failed");
	await expect(page.getByTestId("named-theme-select")).toHaveValue(selected);
	await page.reload();
	await goToSettings(page);
	await expect(page.getByTestId("named-theme-select")).toHaveValue(selected);
	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	await expect(page.getByTestId("email")).toBeVisible();
	await expect(page.locator("html")).not.toHaveAttribute(
		"data-theme-document",
		"true",
	);
	await signUp(page, uniqueEmail("theme-import-other"));
	await goToSettings(page);
	await expect(page.getByTestId("named-theme-select")).toHaveValue("default");
	await expect(
		page.getByRole("option", { name: "My palette", exact: true }),
	).toHaveCount(0);
});

test("theme editor previews without saving, cancels, then saves paired palettes", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("theme-editor"));
	await goToSettings(page);
	await page.getByTestId("theme-switcher").click();
	await page.getByRole("option", { name: "Light", exact: true }).click();
	await page.getByTestId("named-theme-select").selectOption("paper");
	await expect
		.poll(() =>
			page.evaluate(() =>
				Object.entries(localStorage).some(
					([key, raw]) =>
						key.startsWith("ditero.themes.") &&
						JSON.parse(raw).selected === "paper",
				),
			),
		)
		.toBe(true);
	const stored = await page.evaluate(
		() =>
			Object.entries(localStorage).find(([key]) =>
				key.startsWith("ditero.themes."),
			)?.[1],
	);
	await page.getByTestId("named-theme-customize").click();
	await expect(page.getByTestId("theme-editor-name")).toBeFocused();
	await expect(page.getByTestId("display-accent-blue")).toBeDisabled();
	await page.evaluate(() => {
		document.documentElement.dir = "rtl";
	});
	await expect(page.getByTestId("theme-editor-light-background")).toHaveCSS(
		"direction",
		"ltr",
	);
	await page.evaluate(() => {
		document.documentElement.dir = "ltr";
	});
	await page.getByTestId("theme-editor-light-background").fill("#ffffff");
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(255, 255, 255)",
	);
	expect(
		await page.evaluate(
			() =>
				Object.entries(localStorage).find(([key]) =>
					key.startsWith("ditero.themes."),
				)?.[1],
		),
	).toBe(stored);
	await page.getByTestId("theme-editor-cancel").click();
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(250, 247, 240)",
	);
	await expect(page.getByTestId("named-theme-customize")).toBeFocused();
	await expect(page.getByTestId("display-accent-blue")).toBeEnabled();
	await page.getByTestId("named-theme-customize").click();
	await page.getByTestId("theme-editor-name").fill("My edited palette");
	await page.getByTestId("theme-editor-light-background").fill("#ffffff");
	await page.getByTestId("theme-editor-dark-background").fill("#101010");
	await page.getByTestId("theme-editor-save").click();
	await expect(page.getByTestId("theme-editor")).toHaveCount(0);
	await expect(
		page.getByTestId("named-theme-select").locator("option:checked"),
	).toHaveText("My edited palette");
	await page.reload();
	await goToSettings(page);
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(255, 255, 255)",
	);
	await page.getByTestId("theme-switcher").click();
	await page.getByRole("option", { name: "Dark", exact: true }).click();
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(16, 16, 16)",
	);
});

test("server-confirmed theme survives a refused local startup cache", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("theme-editor-storage"));
	await goToSettings(page);
	await page.getByTestId("theme-switcher").click();
	await page.getByRole("option", { name: "Light", exact: true }).click();
	await page.getByTestId("named-theme-select").selectOption("paper");
	await page.getByTestId("named-theme-customize").click();
	await page.getByTestId("theme-editor-light-background").fill("#ffffff");
	await page.evaluate(() => {
		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (key.startsWith("ditero.themes."))
				throw new DOMException("Quota exceeded", "QuotaExceededError");
			return original.call(this, key, value);
		};
	});
	await page.getByTestId("theme-editor-save").click();
	await expect(page.getByTestId("theme-editor")).toHaveCount(0);
	await expect(
		page.getByRole("status").filter({ hasText: "local startup cache" }),
	).toBeVisible();
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(255, 255, 255)",
	);
	await page.reload();
	await goToSettings(page);
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(255, 255, 255)",
	);
});

test("theme editor rejects unreadable drafts and restores the saved palette on navigation", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("theme-editor-invalid"));
	await goToSettings(page);
	await page.getByTestId("theme-switcher").click();
	await page.getByRole("option", { name: "Light", exact: true }).click();
	await page.getByTestId("named-theme-select").selectOption("paper");
	await page.getByTestId("named-theme-customize").click();
	await page.getByTestId("theme-editor-light-foreground").fill("#faf7f0");
	await expect(page.getByTestId("theme-editor-save")).toBeDisabled();
	await expect(
		page.getByTestId("theme-editor").getByRole("status"),
	).toContainText("Text contrast must be at least 4.5:1");
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(250, 247, 240)",
	);
	await page.getByTestId("theme-editor-cancel").click();
	await page.getByTestId("named-theme-customize").click();
	await page.getByTestId("theme-editor-light-background").fill("#ffffff");
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(255, 255, 255)",
	);
	await page.getByTestId("settings-back").click();
	await expect(page.getByTestId("theme-editor")).toHaveCount(0);
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(250, 247, 240)",
	);
});

test("account palettes and accents reach a fresh browser context after server acknowledgment and offline reconnect", async ({
	page,
	context,
	browser,
}) => {
	const userId = await signUp(page, uniqueEmail("theme-sync"));
	const second = await browser.newContext({
		viewport: { width: 390, height: 844 },
		storageState: {
			cookies: (await context.storageState()).cookies,
			origins: [],
		},
	});
	const other = await second.newPage();
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await other.goto(page.url());
		await goToSettings(other);
		await goToSettings(page);
		await page.getByTestId("named-theme-select").selectOption("slate");
		await expect(other.getByTestId("named-theme-select")).toHaveValue("slate");
		await expect
			.poll(
				async () =>
					(
						await pool.query(
							"select appearance->>'selected' as selected from user_pref where id=$1",
							[userId],
						)
					).rows[0]?.selected,
			)
			.toBe("slate");
		await page.getByTestId("display-size-large").check();
		await expect(other.locator("html")).toHaveAttribute(
			"data-reading-size",
			"standard",
		);
		await context.setOffline(true);
		await page.getByTestId("named-theme-select").selectOption("paper");
		await expect(
			page.getByRole("status").filter({ hasText: "Waiting for the server" }),
		).toBeVisible();
		await expect(page.getByTestId("named-theme-select")).toHaveValue("paper");
		await expect(other.getByTestId("named-theme-select")).toHaveValue("slate");
		expect(
			(
				await pool.query(
					"select appearance->>'selected' as selected from user_pref where id=$1",
					[userId],
				)
			).rows[0].selected,
		).toBe("slate");
		await context.setOffline(false);
		await expect(other.getByTestId("named-theme-select")).toHaveValue("paper");
		await expect(
			page.getByRole("status").filter({ hasText: "Waiting for the server" }),
		).toHaveCount(0);
		await page.getByTestId("display-accent-blue").check();
		await expect(other.getByTestId("display-accent-blue")).toBeChecked();
		await other.reload();
		await goToSettings(other);
		await expect(other.getByTestId("named-theme-select")).toHaveValue("paper");
		await expect(other.getByTestId("display-accent-blue")).toBeChecked();
	} finally {
		await context.setOffline(false);
		await second.close();
		await pool.end();
	}
});

test("legacy themes remain hints until the first explicit action migrates the library", async ({
	page,
	context,
	browser,
}) => {
	const userId = await signUp(page, uniqueEmail("theme-legacy"));
	const legacy = {
		selected: "legacy-palette",
		useAccent: false,
		documents: [
			{
				id: "legacy-palette",
				document: {
					...BUILTIN_THEME_DOCUMENTS.paper,
					name: "Earlier device palette",
				},
			},
		],
	};
	await page.evaluate(
		({ userId, legacy }) =>
			localStorage.setItem(`ditero.themes.${userId}`, JSON.stringify(legacy)),
		{ userId, legacy },
	);
	await page.reload();
	await goToSettings(page);
	await expect(page.getByTestId("named-theme-select")).toHaveValue("default");
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	const second = await browser.newContext({
		viewport: { width: 390, height: 844 },
		storageState: {
			cookies: (await context.storageState()).cookies,
			origins: [],
		},
	});
	try {
		expect(
			(
				await pool.query("select appearance from user_pref where id=$1", [
					userId,
				])
			).rows[0]?.appearance ?? null,
		).toBeNull();
		await page.getByTestId("named-theme-select").selectOption("paper");
		await expect(page.getByTestId("named-theme-select")).toBeEnabled();
		const other = await second.newPage();
		await other.goto(page.url());
		await goToSettings(other);
		await expect(
			other.getByRole("option", {
				name: "Earlier device palette",
				exact: true,
			}),
		).toHaveCount(1);
		await expect(other.getByTestId("named-theme-select")).toHaveValue("paper");
		await page.reload();
		await goToSettings(page);
		await expect(page.getByTestId("named-theme-select")).toHaveValue("paper");
	} finally {
		await second.close();
		await pool.end();
	}
});

test("server rejection keeps an editable draft and retry submits the preserved change", async ({
	page,
}) => {
	const userId = await signUp(page, uniqueEmail("theme-refusal"));
	await goToSettings(page);
	await page.getByTestId("named-theme-select").selectOption("paper");
	await expect(page.getByTestId("named-theme-select")).toBeEnabled();
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await pool.query(
			`create function theme_sync_refuse() returns trigger language plpgsql as $$ begin if NEW.id = '${userId}' then raise exception 'Theme fixture refusal'; end if; return NEW; end $$`,
		);
		await pool.query(
			"create trigger theme_sync_refuse before update on user_pref for each row execute function theme_sync_refuse()",
		);
		await page.getByTestId("named-theme-customize").click();
		await page.getByTestId("theme-editor-name").fill("Preserved draft");
		await page.getByTestId("theme-editor-light-background").fill("#ffffff");
		await page.getByTestId("theme-editor-save").click();
		await expect(
			page.getByTestId("theme-editor").getByRole("alert"),
		).toContainText("Could not save");
		await expect(page.getByTestId("theme-editor-name")).toHaveValue(
			"Preserved draft",
		);
		await expect(page.getByTestId("theme-editor-save")).toBeEnabled();
		expect(
			(
				await pool.query(
					"select appearance->>'selected' as selected from user_pref where id=$1",
					[userId],
				)
			).rows[0].selected,
		).toBe("paper");
		await pool.query("drop trigger theme_sync_refuse on user_pref");
		await pool.query("drop function theme_sync_refuse()");
		await page.getByTestId("theme-editor-name").fill("Retried draft");
		await page.getByTestId("theme-editor-save").click();
		await expect(page.getByTestId("theme-editor")).toHaveCount(0);
		await expect(
			page.getByTestId("named-theme-select").locator("option:checked"),
		).toHaveText("Retried draft");
		await page.reload();
		await goToSettings(page);
		await expect(
			page.getByTestId("named-theme-select").locator("option:checked"),
		).toHaveText("Retried draft");
	} finally {
		await pool.query("drop trigger if exists theme_sync_refuse on user_pref");
		await pool.query("drop function if exists theme_sync_refuse()");
		await pool.end();
	}
});
