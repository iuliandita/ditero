import { expect, test } from "@playwright/test";
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

test("theme editor keeps the saved palette intact when local persistence fails", async ({
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
	await expect(
		page.getByTestId("theme-editor").getByRole("alert"),
	).toBeVisible();
	await page.getByTestId("theme-editor-cancel").click();
	await expect(page.getByTestId("named-theme-select")).toHaveValue("paper");
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(250, 247, 240)",
	);
	await page.reload();
	await goToSettings(page);
	await expect(page.getByTestId("named-theme-select")).toHaveValue("paper");
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
