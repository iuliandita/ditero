import { expect, test } from "@playwright/test";
import { goToSettings, signUp, uniqueEmail } from "./helpers.ts";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test("the phone Appearance shortcut and section selector follow reading-size changes", async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await signUp(page, uniqueEmail("reading-sections"));
	await goToSettings(page);
	await page.getByTestId("display-size-large").check();
	await page.getByTestId("settings-back").click();
	await page.getByTestId("nav-tab-lists").click();
	await page.getByTestId("workspace-switcher").click();
	await page.getByTestId("switcher-appearance").click();
	await expect(page.getByRole("menu")).toHaveCount(0);
	await expect(page.locator("#settings-appearance-heading")).toBeFocused();
	const selector = page.getByTestId("settings-section-select");
	await expect(selector).toHaveText("Appearance and language");
	const selectSection = async (name: string, id: string) => {
		await selector.click();
		const option = page.getByRole("option", { name, exact: true });
		// A resize can make this section current already. Selecting its unchanged
		// value closes the menu without the changed-value focus handoff.
		if ((await option.getAttribute("data-state")) === "checked") {
			const other =
				id === "account"
					? { name: "Appearance and language", id: "appearance" }
					: { name: "Account", id: "account" };
			await page.getByRole("option", { name: other.name, exact: true }).click();
			await expect(page.getByRole("listbox")).toHaveCount(0);
			await expect(page.locator(`#settings-${other.id}-heading`)).toBeFocused();
			await expect(selector).toHaveText(other.name);
			await selector.click();
		}
		await option.click();
		await expect(page.getByRole("listbox")).toHaveCount(0);
		await expect(page.locator(`#settings-${id}-heading`)).toBeFocused();
		await expect(selector).toHaveText(name);
	};
	await selectSection("Account", "account");
	await selectSection("Appearance and language", "appearance");
	for (const preset of ["comfortable", "large"] as const) {
		await page.getByTestId(`display-size-${preset}`).check();
		await expect(page.locator("html")).toHaveAttribute(
			"data-reading-size",
			preset,
		);
		await selectSection("Account", "account");
		await selectSection("Appearance and language", "appearance");
	}
});

test("blocked appearance storage applies changes now and resets on reload and account change", async ({
	page,
}) => {
	await page.addInitScript(() => {
		const setItem = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (this === localStorage && key.startsWith("ditero.display."))
				throw new DOMException(
					"Appearance storage blocked",
					"QuotaExceededError",
				);
			return setItem.call(this, key, value);
		};
	});
	const userId = await signUp(page, uniqueEmail("blocked-reading"));
	await goToSettings(page);
	await page.getByTestId("display-size-large").check();
	await page.getByTestId("display-high-contrast").click();
	await expect(page.locator("html")).toHaveAttribute(
		"data-reading-size",
		"large",
	);
	await expect(page.locator("html")).toHaveAttribute(
		"data-high-contrast",
		"true",
	);
	await expect(page.getByTestId("display-high-contrast")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect(
		page.getByTestId("display-settings").getByRole("status"),
	).toHaveText(
		"Your changes apply now, but could not be saved on this device.",
	);
	expect(
		await page.evaluate(
			(id) => localStorage.getItem(`ditero.display.${id}`),
			userId,
		),
	).toBeNull();
	await page.reload();
	await goToSettings(page);
	await expect(page.getByTestId("display-size-standard")).toBeChecked();
	await expect(page.getByTestId("display-high-contrast")).toHaveAttribute(
		"aria-checked",
		"false",
	);
	await page.getByTestId("display-size-large").check();
	await page.getByTestId("display-high-contrast").click();
	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	await expect(page.getByTestId("email")).toBeVisible();
	await signUp(page, uniqueEmail("blocked-other-reader"));
	await goToSettings(page);
	await expect(page.getByTestId("display-size-standard")).toBeChecked();
	await expect(page.getByTestId("display-high-contrast")).toHaveAttribute(
		"aria-checked",
		"false",
	);
	await expect(
		page.getByTestId("display-settings").getByRole("status"),
	).toHaveCount(0);
});

test("the desktop reading shortcut leaves focus in Appearance", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await signUp(page, uniqueEmail("reading-shortcut"));
	await page.getByTestId("workspace-switcher").click();
	await page.getByTestId("switcher-appearance").click();
	await expect(page.getByRole("menu")).toHaveCount(0);
	await expect(page.locator("#settings-appearance-heading")).toBeFocused();
	await expect(page.getByTestId("display-settings")).toBeVisible();
});

test("reading presets change rendered sizes and survive a reload", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("reading"));
	await goToSettings(page);
	const settings = page.getByTestId("display-settings");
	for (const [preset, text, mark, target] of [
		["comfortable", 16, 24, 48],
		["large", 18, 28, 56],
	] as const) {
		await page.getByTestId(`display-size-${preset}`).check();
		await expect
			.poll(async () =>
				settings.evaluate((element) => {
					const description = element.querySelector("fieldset p");
					const radio = element.querySelector("input:checked");
					const toggle = element.querySelector('[role="switch"]');
					if (!description || !radio || !toggle)
						throw new Error("missing reading controls");
					return {
						text: Number.parseFloat(getComputedStyle(description).fontSize),
						mark: radio.getBoundingClientRect().width,
						target: toggle.getBoundingClientRect().height,
					};
				}),
			)
			.toEqual({ text, mark, target });
	}
	await page.reload();
	await goToSettings(page);
	await expect(page.getByTestId("display-size-large")).toBeChecked();
	await expect
		.poll(() =>
			page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
		)
		.toBe(true);
});

test("high contrast renders in both themes and does not carry into another account", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("contrast"));
	await goToSettings(page);
	await page.getByTestId("display-size-large").check();
	await page.getByTestId("display-high-contrast").click();
	for (const theme of ["Light", "Dark"]) {
		await page.getByTestId("theme-switcher").click();
		await page.getByRole("option", { name: theme, exact: true }).click();
		await expect(page.getByRole("listbox")).toHaveCount(0);
		const ratio = await page
			.getByTestId("display-settings")
			.evaluate((element) => {
				const text = element.querySelector("fieldset p");
				if (!text) throw new Error("missing description");
				const canvas = document.createElement("canvas");
				canvas.width = canvas.height = 1;
				const context = canvas.getContext("2d");
				if (!context) throw new Error("missing color conversion context");
				const luminance = (color: string) => {
					context.fillStyle = color;
					context.fillRect(0, 0, 1, 1);
					const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
					const linear = [r, g, b].map((channel) => {
						const value = channel / 255;
						return value <= 0.04045
							? value / 12.92
							: ((value + 0.055) / 1.055) ** 2.4;
					});
					return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
				};
				const foreground = luminance(getComputedStyle(text).color);
				const background = luminance(
					getComputedStyle(document.body).backgroundColor,
				);
				return (
					(Math.max(foreground, background) + 0.05) /
					(Math.min(foreground, background) + 0.05)
				);
			});
		expect(ratio).toBeGreaterThanOrEqual(7);
	}
	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	await expect(page.getByTestId("email")).toBeVisible();
	await expect(page.locator("html")).toHaveAttribute(
		"data-reading-size",
		"standard",
	);
	await expect(page.locator("html")).toHaveAttribute(
		"data-high-contrast",
		"false",
	);
	await signUp(page, uniqueEmail("other-reader"));
	await goToSettings(page);
	await expect(page.getByTestId("display-size-standard")).toBeChecked();
	await expect(page.getByTestId("display-high-contrast")).toHaveAttribute(
		"aria-checked",
		"false",
	);
});
