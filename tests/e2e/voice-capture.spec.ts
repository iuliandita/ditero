import {
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import {
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
	webOrigin,
} from "./helpers.ts";

// Strict on-device voice capture (#830) in quick add. A fake Web Speech API
// with processLocally and an "available" installed pack stands in for the
// engine; real engine/locale/microphone behavior is NOT exercised here.

type Fake = {
	started: number;
	checks: number;
	lastCheck: { langs: string[]; processLocally: boolean } | null;
	instances: number;
	holdAvailability: boolean;
	releaseAvailability(): void;
	final(alternatives: string[]): void;
	error(code: string): void;
	emitSaved(index: number, alternatives: string[]): void;
};

declare global {
	interface Window {
		__voiceFake: Fake;
	}
}

async function installFake(page: Page) {
	await page.addInitScript(() => {
		type Handlers = {
			onresult: ((e: unknown) => void) | null;
			onerror: ((e: unknown) => void) | null;
		};
		const instances: Array<Handlers & { saved?: Handlers["onresult"] }> = [];
		let release: () => void = () => {};
		const event = (alternatives: string[]) => ({
			results: [
				Object.assign(
					alternatives.map((transcript) => ({ transcript })),
					{ isFinal: true },
				),
			],
		});
		const fake = {
			started: 0,
			// Capability checks; a check never starts a recognition.
			checks: 0,
			lastCheck: null as { langs: string[]; processLocally: boolean } | null,
			get instances() {
				return instances.length;
			},
			holdAvailability: false,
			releaseAvailability: () => release(),
			final: (alternatives: string[]) =>
				instances.at(-1)?.onresult?.(event(alternatives)),
			error: (code: string) => instances.at(-1)?.onerror?.({ error: code }),
			// A handler reference kept from an earlier session, called after the
			// controller already moved on.
			emitSaved: (index: number, alternatives: string[]) =>
				instances[index]?.saved?.(event(alternatives)),
		};
		class FakeRecognition {
			lang = "";
			continuous = false;
			interimResults = false;
			maxAlternatives = 1;
			processLocally = false;
			onresult: Handlers["onresult"] = null;
			onerror: Handlers["onerror"] = null;
			onnomatch: ((e: unknown) => void) | null = null;
			onend: ((e: unknown) => void) | null = null;
			saved: Handlers["onresult"] = null;
			static available(options: { langs: string[]; processLocally: boolean }) {
				fake.lastCheck = {
					langs: [...options.langs],
					processLocally: options.processLocally,
				};
				fake.checks += 1;
				if (!fake.holdAvailability) return Promise.resolve("available");
				return new Promise<string>((resolve) => {
					release = () => resolve("available");
				});
			}
			start() {
				fake.started += 1;
				this.saved = this.onresult;
				instances.push(this);
			}
			stop() {}
			abort() {}
		}
		(window as unknown as { SpeechRecognition: unknown }).SpeechRecognition =
			FakeRecognition;
		window.__voiceFake = fake as unknown as Fake;
	});
}

async function setLocale(context: BrowserContext, locale: string) {
	await context.addCookies([
		{ name: "PARAGLIDE_LOCALE", value: locale, url: webOrigin() },
	]);
	await context.addInitScript((value) => {
		localStorage.setItem("PARAGLIDE_LOCALE", value);
	}, locale);
}

async function phone(browser: Browser, width = 390) {
	const context = await browser.newContext({
		viewport: { width, height: 844 },
		hasTouch: true,
		isMobile: true,
	});
	return { context, page: await context.newPage() };
}

// Sign up, create a first list, and open quick add. On a phone creating the
// list may already open quick add over it.
async function openQuickAdd(page: Page, prefix: string, hold = false) {
	await installFake(page);
	if (hold) {
		await page.addInitScript(() => {
			window.__voiceFake.holdAvailability = true;
		});
	}
	await signUp(page, uniqueEmail(prefix));
	await waitWorkspaceReady(page);
	await expect(page.getByTestId("view-empty-first-use")).toBeVisible({
		timeout: 15000,
	});
	await page.getByTestId("first-run-create-list").click();
	await page.getByTestId("new-list").fill("Errands");
	await page.getByTestId("new-list").press("Enter");
	await expect(page.locator('[data-testid="list"] h1')).toHaveText("Errands", {
		timeout: 15000,
	});
	const input = page.getByTestId("quickadd-input");
	if (!(await input.isVisible().catch(() => false))) {
		await page.getByTestId("syntax-hint-open-quickadd").click();
	}
	await expect(input).toBeVisible();
	return input;
}

// Resolves once every finite animation and transition has finished (the sheet
// and dialog open animations included), so a frame is never captured mid-enter.
// Normal motion stays on; nothing here is a fixed sleep.
async function settle(page: Page) {
	const remaining = await page.evaluate(async () => {
		const frame = () =>
			new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		const running = () =>
			document
				.getAnimations()
				.filter(
					(a) =>
						(a.playState === "running" || a.pending) &&
						a.effect?.getComputedTiming().iterations !== Infinity,
				);
		await frame();
		await frame();
		for (let i = 0; i < 20 && running().length > 0; i++) {
			await Promise.allSettled(running().map((a) => a.finished));
			await frame();
		}
		return running().length;
	});
	expect(remaining).toBe(0);
}

async function shot(page: Page, name: string) {
	await settle(page);
	await page.screenshot({ path: test.info().outputPath(name) });
}

const start = (page: Page) => page.getByTestId("quickadd-voice-start");
const review = (page: Page) => page.getByTestId("quickadd-voice-review");
const taskList = (page: Page) => page.getByTestId("list");

async function dictate(page: Page) {
	await expect(start(page)).toBeEnabled();
	await start(page).click();
	await expect(page.getByTestId("quickadd-voice-stop")).toBeVisible();
}

test("a result waits in review; Use this text appends and Add creates exactly one task", async ({
	page,
}) => {
	const input = await openQuickAdd(page, "voice1");
	await expect(start(page)).toBeEnabled();
	await shot(page, "voice-ready.png");
	await input.fill("Buy");
	// Positive control: the mic starts exactly one recognition.
	await dictate(page);
	expect(await page.evaluate(() => window.__voiceFake.started)).toBe(1);

	await page.evaluate(() => window.__voiceFake.final(["milk"]));
	await expect(review(page)).toBeVisible();
	await shot(page, "voice-review.png");
	await expect(input).toHaveValue("Buy");
	await expect(taskList(page)).not.toContainText("Buy milk");

	await page.getByTestId("quickadd-voice-use").click();
	await expect(input).toHaveValue("Buy milk");
	await expect(review(page)).toHaveCount(0);
	await expect(taskList(page)).not.toContainText("Buy milk");

	await page.getByTestId("quickadd-submit").click();
	await expect(input).toHaveValue("");
	await page.keyboard.press("Escape");
	await expect(
		taskList(page).getByRole("checkbox", { name: "Buy milk", exact: true }),
	).toHaveCount(1);
});

test("multiple alternatives are radios and the chosen one is used", async ({
	page,
}) => {
	const input = await openQuickAdd(page, "voice2");
	await dictate(page);
	await page.evaluate(() =>
		window.__voiceFake.final(["Call Ann", "Call Anne"]),
	);
	const choices = page.getByRole("radio");
	await expect(choices).toHaveCount(2);
	await expect(choices.first()).toBeChecked();
	await choices.nth(1).check();
	await page.getByTestId("quickadd-voice-use").click();
	await expect(input).toHaveValue("Call Anne");
});

test("Enter cannot save while recording or in review, and the refusal is announced", async ({
	page,
}) => {
	const blockedText = "Finish or cancel voice input to add the task.";
	const input = await openQuickAdd(page, "voice3");
	const live = page.getByTestId("quickadd-voice-blocked-announcement");
	const announced = live.locator("span");
	// The text of the announced child, or "" once a fresh child replaced the
	// marked one. The mark lives on the DOM node, so only a new node loses it.
	const markOf = () =>
		announced.evaluate((el) => (el as HTMLElement).dataset.mark ?? "");
	await input.fill("Water plants");

	// The live region is mounted up front, polite and atomic, and stays empty
	// until Enter is actually refused.
	await expect(live).toHaveAttribute("role", "status");
	await expect(live).toHaveAttribute("aria-live", "polite");
	await expect(live).toHaveAttribute("aria-atomic", "true");
	await expect(live).toBeEmpty();
	await dictate(page);
	await expect(page.getByTestId("quickadd-submit")).toBeDisabled();
	await expect(live).toBeEmpty();

	await input.focus();
	await page.keyboard.press("Enter");
	await expect(live).toHaveText(blockedText);
	await expect(announced).toHaveCount(1);
	await expect(input).toHaveValue("Water plants");
	await expect(input).toBeFocused();
	await expect(page.getByTestId("quickadd-voice-stop")).toBeVisible();
	await expect(taskList(page)).not.toContainText("Water plants");
	expect(await startedCount(page)).toBe(1);

	// A repeated refusal is a fresh DOM update, not the same node re-read.
	await announced.evaluate((el) => {
		(el as HTMLElement).dataset.mark = "first";
	});
	expect(await markOf()).toBe("first");
	await page.keyboard.press("Enter");
	await expect.poll(markOf).toBe("");
	await expect(live).toHaveText(blockedText);
	await expect(announced).toHaveCount(1);
	await expect(input).toHaveValue("Water plants");
	await expect(input).toBeFocused();
	await expect(page.getByTestId("quickadd-voice-stop")).toBeVisible();
	expect(await startedCount(page)).toBe(1);

	// A stopped recording still blocks while the engine has not ended.
	await page.getByTestId("quickadd-voice-stop").click();
	await expect(page.getByTestId("quickadd-voice-status")).toHaveText(
		"Finishing...",
	);
	await announced.evaluate((el) => {
		(el as HTMLElement).dataset.mark = "stopping";
	});
	await input.focus();
	await page.keyboard.press("Enter");
	await expect.poll(markOf).toBe("");
	await expect(live).toHaveText(blockedText);
	await expect(input).toHaveValue("Water plants");
	await expect(input).toBeFocused();
	await expect(taskList(page)).not.toContainText("Water plants");

	await page.evaluate(() => window.__voiceFake.final(["today"]));
	await expect(review(page)).toBeVisible();
	// Still blocked in review: the same refusal is announced again.
	await expect(announced).toHaveCount(1);
	await announced.evaluate((el) => {
		(el as HTMLElement).dataset.mark = "review";
	});
	await input.focus();
	await page.keyboard.press("Enter");
	await expect.poll(markOf).toBe("");
	await expect(live).toHaveText(blockedText);
	await expect(announced).toHaveCount(1);
	await expect(input).toHaveValue("Water plants");
	await expect(input).toBeFocused();
	await expect(review(page)).toBeVisible();
	await expect(taskList(page)).not.toContainText("Water plants");
	expect(await startedCount(page)).toBe(1);

	// Positive control: leaving review clears the announcement and unblocks the
	// same Enter, which creates exactly one task.
	await page.getByTestId("quickadd-voice-cancel").click();
	await expect(live).toBeEmpty();
	await expect(input).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(input).toHaveValue("");
	await expect(live).toBeEmpty();
	await page.keyboard.press("Escape");
	await expect(
		taskList(page).getByRole("checkbox", { name: "Water plants", exact: true }),
	).toHaveCount(1);
});

test("permission, engine, oversize errors and cancel leave the draft alone", async ({
	page,
}) => {
	const input = await openQuickAdd(page, "voice4");
	await input.fill("Draft kept");

	await dictate(page);
	await page.evaluate(() => window.__voiceFake.error("not-allowed"));
	const alert = page.getByRole("alert");
	await expect(alert).toHaveText(
		"Microphone access is blocked. Allow the microphone for this site in your browser settings, then choose “Check again”, then “Dictate”.",
	);
	await shot(page, "voice-error.png");
	await expect(input).toHaveValue("Draft kept");

	// The guidance names the real controls: only Check again is offered while
	// the error shows, and it probes without listening.
	const checkAgain = page.getByTestId("quickadd-voice-retry");
	await expect(checkAgain).toHaveText("Check again");
	await expect(start(page)).toHaveCount(0);
	const listened = await startedCount(page);
	expect(listened).toBe(1);
	const checked = await page.evaluate(() => window.__voiceFake.checks);
	await checkAgain.click();
	await expect
		.poll(() => page.evaluate(() => window.__voiceFake.checks))
		.toBeGreaterThan(checked);
	expect(await page.evaluate(() => window.__voiceFake.lastCheck)).toEqual({
		langs: ["en-US"],
		processLocally: true,
	});
	await expect(start(page)).toBeEnabled();
	await expect(start(page)).toHaveText("Dictate");
	expect(await startedCount(page)).toBe(listened);

	// Only the separate Dictate click starts a recognition.
	await dictate(page);
	expect(await startedCount(page)).toBe(listened + 1);
	await page.evaluate(() => window.__voiceFake.final(["x".repeat(501)]));
	await expect(alert).toHaveText(
		"That was too long to use. Choose “Check again”, then “Dictate” and say a shorter task.",
	);
	await expect(input).toHaveValue("Draft kept");

	// Check again after the second error, then Dictate delivers a result.
	await checkAgain.click();
	await expect(start(page)).toBeEnabled();
	expect(await startedCount(page)).toBe(listened + 1);
	await dictate(page);
	expect(await startedCount(page)).toBe(listened + 2);
	await page.evaluate(() => window.__voiceFake.final(["fresh"]));
	await expect(review(page)).toContainText("fresh");
	await expect(input).toHaveValue("Draft kept");
	await page.getByTestId("quickadd-voice-cancel").click();
	await expect(start(page)).toBeEnabled();

	await dictate(page);
	await page.getByTestId("quickadd-voice-cancel").click();
	await expect(start(page)).toBeEnabled();
	await expect(input).toHaveValue("Draft kept");
});

test("a saved callback after cancel or from an older session is ignored", async ({
	page,
}) => {
	const input = await openQuickAdd(page, "voice5");
	await input.fill("Keep");
	await dictate(page);
	await page.getByTestId("quickadd-voice-cancel").click();
	await expect(start(page)).toBeEnabled();
	await page.evaluate(() => window.__voiceFake.emitSaved(0, ["stale one"]));
	await expect(review(page)).toHaveCount(0);

	await dictate(page);
	await page.evaluate(() => window.__voiceFake.emitSaved(0, ["stale two"]));
	await expect(review(page)).toHaveCount(0);
	// Positive control: the current session still delivers.
	await page.evaluate(() => window.__voiceFake.final(["fresh"]));
	await expect(review(page)).toContainText("fresh");
	await expect(input).toHaveValue("Keep");
});

test("Escape cancels voice only, then the next Escape closes the sheet", async ({
	page,
}) => {
	const input = await openQuickAdd(page, "voice6");
	await dictate(page);
	await page.keyboard.press("Escape");
	await expect(input).toBeVisible();
	await expect(start(page)).toBeEnabled();

	await page.keyboard.press("Escape");
	await expect(input).toHaveCount(0);
});

test("a probe still pending when the sheet closes never starts listening", async ({
	page,
}) => {
	const input = await openQuickAdd(page, "voice7", true);
	await expect(start(page)).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(input).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(input).toHaveCount(0);
	await page.evaluate(() => window.__voiceFake.releaseAvailability());
	await page.evaluate(() => {
		window.__voiceFake.holdAvailability = false;
	});
	expect(await page.evaluate(() => window.__voiceFake.started)).toBe(0);

	// Positive control: a fresh open probes, enables the mic, and still waits
	// for the click before listening.
	await page.getByTestId("syntax-hint-open-quickadd").click();
	await expect(start(page)).toBeEnabled();
	expect(await page.evaluate(() => window.__voiceFake.started)).toBe(0);
	await start(page).click();
	expect(await page.evaluate(() => window.__voiceFake.started)).toBe(1);
});

const submit = (page: Page) => page.getByTestId("quickadd-submit");
const retry = (page: Page) => page.getByTestId("quickadd-voice-retry");
const startedCount = (page: Page) =>
	page.evaluate(() => window.__voiceFake.started);

// The automatic open-time capability probe is not a voice action: typed Add and
// Enter stay usable while it is pending.
for (const via of ["Enter", "Add"] as const) {
	test(`typed ${via} saves while the automatic probe is pending`, async ({
		page,
	}) => {
		const input = await openQuickAdd(page, `voice9-${via}`, true);
		await input.fill("Pay rent");
		await expect(start(page)).toBeDisabled();
		await expect(submit(page)).toBeEnabled();
		if (via === "Enter") await input.press("Enter");
		else await submit(page).click();
		await expect(input).toHaveValue("");
		expect(await startedCount(page)).toBe(0);

		// The first Escape cancels the passive probe, the second closes.
		await page.keyboard.press("Escape");
		await expect(input).toBeVisible();
		await expect(retry(page)).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(input).toHaveCount(0);
		await expect(
			taskList(page).getByRole("checkbox", { name: "Pay rent", exact: true }),
		).toHaveCount(1);

		// The old probe resolving after close must not start anything.
		await page.evaluate(() => window.__voiceFake.releaseAvailability());
		await page.evaluate(() => {
			window.__voiceFake.holdAvailability = false;
		});
		expect(await startedCount(page)).toBe(0);

		// Positive control: a fresh open passes the probe, still waits for the
		// click, and the current session delivers.
		await page.getByTestId("syntax-hint-open-quickadd").click();
		await expect(start(page)).toBeEnabled();
		expect(await startedCount(page)).toBe(0);
		await start(page).click();
		expect(await startedCount(page)).toBe(1);
		await page.evaluate(() => window.__voiceFake.final(["fresh"]));
		await expect(review(page)).toContainText("fresh");
	});
}

test("a cancelled probe offers Retry; a user check blocks submit until it resolves", async ({
	page,
}) => {
	const input = await openQuickAdd(page, "voice10", true);
	await input.fill("Draft stays");
	await expect(start(page)).toBeDisabled();

	// Cancel the passive probe: idle and not ready, with an explicit Retry.
	await page.getByTestId("quickadd-voice-cancel").click();
	await expect(retry(page)).toBeVisible();
	await expect(start(page)).toBeDisabled();
	await expect(input).toHaveValue("Draft stays");
	expect(await startedCount(page)).toBe(0);
	// The cancelled probe resolving late is stale and must not enable the mic.
	await page.evaluate(() => window.__voiceFake.releaseAvailability());

	// Retry is a user check (still held): Add is disabled and Enter is ignored.
	await retry(page).click();
	await expect(page.getByTestId("quickadd-voice-cancel")).toBeVisible();
	await expect(start(page)).toBeDisabled();
	await expect(submit(page)).toBeDisabled();
	await input.press("Enter");
	await expect(input).toHaveValue("Draft stays");
	await expect(
		page.getByTestId("quickadd-voice-blocked-announcement"),
	).toHaveText("Finish or cancel voice input to add the task.");
	const live = page.getByTestId("quickadd-voice-blocked-announcement");
	const announced = live.locator("span");
	await announced.evaluate((el) => {
		(el as HTMLElement).dataset.mark = "checking";
	});
	await input.press("Enter");
	await expect
		.poll(() =>
			announced.evaluate((el) => (el as HTMLElement).dataset.mark ?? ""),
		)
		.toBe("");
	await expect(live).toHaveText(
		"Finish or cancel voice input to add the task.",
	);
	await expect(input).toHaveValue("Draft stays");
	await expect(input).toBeFocused();
	await expect(taskList(page)).not.toContainText("Draft stays");

	// Cancelling the user check returns to Retry, and typed submit is usable.
	await page.getByTestId("quickadd-voice-cancel").click();
	await expect(live).toBeEmpty();
	await expect(retry(page)).toBeVisible();
	await expect(start(page)).toBeDisabled();
	await expect(submit(page)).toBeEnabled();
	await expect(input).toHaveValue("Draft stays");
	await page.evaluate(() => window.__voiceFake.releaseAvailability());
	await page.evaluate(() => {
		window.__voiceFake.holdAvailability = false;
	});

	// Retry now passes: the mic enables but nothing listens until the click.
	await retry(page).click();
	await expect(start(page)).toBeEnabled();
	await expect(retry(page)).toHaveCount(0);
	expect(await startedCount(page)).toBe(0);
	await start(page).click();
	expect(await startedCount(page)).toBe(1);
	await page.evaluate(() => window.__voiceFake.final(["by phone"]));
	await expect(review(page)).toContainText("by phone");
	await expect(input).toHaveValue("Draft stays");

	// Leaving review unblocks Enter; exactly one task exists, so neither the
	// ignored Enter above nor this one saved a duplicate.
	await page.getByTestId("quickadd-voice-cancel").click();
	await expect(input).toHaveValue("Draft stays");
	await input.press("Enter");
	await expect(input).toHaveValue("");
	await page.keyboard.press("Escape");
	await expect(
		taskList(page).getByRole("checkbox", { name: "Draft stays", exact: true }),
	).toHaveCount(1);
});

// Keyboard only: no pointer touches the voice controls. Each explicit phase
// hands focus to the control that now matters, and the passive probe never does.
test("keyboard only: focus follows each voice phase and nothing saves before Add", async ({
	page,
}) => {
	const input = await openQuickAdd(page, "voice11", true);
	const stop = page.getByTestId("quickadd-voice-stop");
	const heard = review(page).getByRole("status");

	// Passive readiness lands while the user is typing and must not steal focus.
	await input.fill("Call");
	await expect(input).toBeFocused();
	await expect(start(page)).toBeDisabled();
	await page.evaluate(() => {
		window.__voiceFake.holdAvailability = false;
		window.__voiceFake.releaseAvailability();
	});
	await expect(start(page)).toBeEnabled();
	await expect(input).toBeFocused();
	expect(await startedCount(page)).toBe(0);

	// Dictate by keyboard: Stop takes focus.
	await page.keyboard.press("Tab");
	await expect(start(page)).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(stop).toBeFocused();
	expect(await startedCount(page)).toBe(1);

	// The result moves focus to the first choice; the live status carries the
	// selected transcript and follows the arrow keys.
	await page.evaluate(() => window.__voiceFake.final(["Ann", "Anne"]));
	const choices = page.getByRole("radio");
	await expect(choices).toHaveCount(2);
	await expect(choices.first()).toBeFocused();
	await expect(heard).toHaveText("Heard on this device: Ann");
	await page.keyboard.press("ArrowDown");
	await expect(choices.nth(1)).toBeChecked();
	await expect(heard).toHaveText("Heard on this device: Anne");
	await expect(input).toHaveValue("Call");

	// Keyboard Use appends and returns focus to the field; nothing is saved yet.
	await page.keyboard.press("Tab");
	await expect(page.getByTestId("quickadd-voice-use")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(input).toHaveValue("Call Anne");
	await expect(input).toBeFocused();
	await expect(review(page)).toHaveCount(0);
	await expect(taskList(page)).not.toContainText("Call Anne");

	// Stopping hands focus to Cancel; Cancel returns it to the field.
	await page.keyboard.press("Tab");
	await expect(start(page)).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(stop).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("quickadd-voice-cancel")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(input).toBeFocused();
	await expect(start(page)).toBeEnabled();

	// Escape while listening cancels voice only and restores the field.
	await page.keyboard.press("Tab");
	await page.keyboard.press("Enter");
	await expect(stop).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(input).toBeFocused();
	await expect(start(page)).toBeEnabled();

	// A listening-time error focuses Check again, which re-checks without
	// listening and then hands focus back to Dictate.
	await page.keyboard.press("Tab");
	await page.keyboard.press("Enter");
	await expect(stop).toBeFocused();
	await page.evaluate(() => window.__voiceFake.error("no-speech"));
	await expect(retry(page)).toBeFocused();
	await expect(retry(page)).toHaveText("Check again");
	const listened = await startedCount(page);
	await page.keyboard.press("Enter");
	await expect(start(page)).toBeEnabled();
	await expect(start(page)).toBeFocused();
	expect(await startedCount(page)).toBe(listened);

	// A single transcript focuses Use; Escape leaves review with the field.
	await page.keyboard.press("Enter");
	await expect(stop).toBeFocused();
	await page.evaluate(() => window.__voiceFake.final(["milk"]));
	await expect(page.getByTestId("quickadd-voice-use")).toBeFocused();
	await expect(heard).toHaveText("Heard on this device: milk");
	await page.keyboard.press("Escape");
	await expect(review(page)).toHaveCount(0);
	await expect(input).toBeFocused();
	await expect(input).toHaveValue("Call Anne");
	await expect(taskList(page)).not.toContainText("Call Anne");

	// Only an explicit Add writes.
	await page.keyboard.press("Enter");
	await expect(input).toHaveValue("");
	await page.keyboard.press("Escape");
	await expect(
		taskList(page).getByRole("checkbox", { name: "Call Anne", exact: true }),
	).toHaveCount(1);
});

test("touch controls are at least 44px in both directions", async ({
	browser,
}) => {
	const { context, page } = await phone(browser);
	await page.emulateMedia({ colorScheme: "dark" });
	await openQuickAdd(page, "voice8");
	await expect(start(page)).toBeEnabled();
	expect(
		await page.evaluate(
			() => matchMedia("(prefers-color-scheme: dark)").matches,
		),
	).toBe(true);
	await shot(page, "voice-phone-dark-ready.png");
	expect(
		await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
	).toBe(true);
	const box = async (id: string) => {
		const b = await page.getByTestId(id).first().boundingBox();
		expect(b, id).not.toBeNull();
		return b as NonNullable<typeof b>;
	};
	const mic = await box("quickadd-voice-start");
	expect(mic.height).toBeGreaterThanOrEqual(44);
	expect(mic.width).toBeGreaterThanOrEqual(44);

	await start(page).click();
	await page.evaluate(() =>
		window.__voiceFake.final(["Call Ann", "Call Anne"]),
	);
	await expect(review(page)).toBeVisible();
	for (const id of [
		"quickadd-voice-use",
		"quickadd-voice-retry",
		"quickadd-voice-cancel",
		"quickadd-voice-choice",
	]) {
		const b = await box(id);
		expect(b.height, id).toBeGreaterThanOrEqual(44);
		expect(b.width, id).toBeGreaterThanOrEqual(44);
	}
	await shot(page, "voice-phone-dark-review.png");
	await context.close();
});

// ar and ro have no date parser: native date words and English ones stay in
// the title and set no due date.
for (const [locale, dir, text, width] of [
	["ar", "rtl", "اشتر الحليب غدا tomorrow", 320],
	["ro", "ltr", "Cumpără lapte mâine tomorrow", 390],
] as const) {
	test(`${locale}: voice text keeps date words in the title and fits ${width}px`, async ({
		browser,
	}) => {
		const { context, page } = await phone(browser, width);
		await setLocale(context, locale);
		const input = await openQuickAdd(page, `voice-${locale}`);
		await expect(page.locator("html")).toHaveAttribute("dir", dir);
		await expect(start(page)).toBeEnabled();
		await shot(page, `voice-${locale}-${width}-ready.png`);
		await dictate(page);
		await page.evaluate((t) => window.__voiceFake.final([t, `${t} 2`]), text);
		await expect(review(page)).toBeVisible();
		const fits = await page
			.getByTestId("quickadd-sheet")
			.evaluate((el) => el.scrollWidth <= el.clientWidth);
		expect(fits).toBe(true);
		await shot(page, `voice-${locale}-${width}-review.png`);
		await page.getByTestId("quickadd-voice-use").click();
		await expect(input).toHaveValue(text);
		await expect(page.getByTestId("chip-date")).toHaveCount(0);
		await page.getByTestId("quickadd-submit").click();
		await expect(input).toHaveValue("");
		await page.keyboard.press("Escape");
		await expect(
			taskList(page).getByRole("checkbox", { name: text, exact: true }),
		).toHaveCount(1);
		await context.close();
	});
}
