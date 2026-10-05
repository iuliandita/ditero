import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
	webOrigin,
} from "./helpers.ts";

// Real engine, no stand-in: the pinned full Chromium exposes the genuine
// SpeechRecognition, and quick add's automatic open-time probe calls its native
// static available({ langs: ["en-US"], processLocally: true }). Whatever that
// reports (available, downloadable, unavailable) the UI must reach a meaningful
// terminal state without crashing the renderer. The microphone is never started
// and nothing is uploaded; voice-capture.spec.ts covers the controller with a
// fake engine.

// The English catalog strings the native completion can land on. A pack that is
// not installed or not ready is a valid outcome here; the generic failure, the
// no-API, no-local-processing, locale and insecure refusals are not.
const CHECKING = "Checking on-device speech...";
const PRIVACY =
	"Audio is processed on this device and never uploaded. Your browser controls microphone access.";
const PACK_MISSING =
	"The on-device speech pack for this language is not installed, so voice input stays off. Keep typing.";
const PACK_PENDING =
	"The on-device speech pack is not ready. Keep typing, or try again later.";
const GENERIC_FAILURE =
	"Voice input stopped. Your text is unchanged. Choose “Check again”, then “Dictate”.";

// Under the 20s domain timeout, so a hung native check cannot be mistaken for
// the controller's own timeout fallback.
const NATIVE_COMPLETION_TIMEOUT = 15_000;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TERMINAL = new RegExp(
	`^(?:${[PRIVACY, PACK_MISSING, PACK_PENDING].map(escapeRegExp).join("|")})$`,
);

// The same locale pattern as voice-capture.spec.ts: cookie plus stored value, so
// the literal English assertions below do not depend on the runner's locale.
async function forceEnglish(page: Page) {
	const context = page.context();
	await context.addCookies([
		{ name: "PARAGLIDE_LOCALE", value: "en", url: webOrigin() },
	]);
	await context.addInitScript((value) => {
		localStorage.setItem("PARAGLIDE_LOCALE", value);
	}, "en");
}

// Renderer crashes and uncaught page errors are observed from Node: a crashed
// page can no longer answer evaluate() or run in-page assertions.
function watchPage(page: Page) {
	const failures: string[] = [];
	page.on("crash", () => failures.push("renderer crashed"));
	page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
	return {
		failures,
		assertAlive() {
			if (page.isClosed()) failures.push("page closed");
			if (failures.length > 0) throw new Error(failures.join("; "));
		},
	};
}

test("quick add's automatic probe reaches a real native availability result", async ({
	page,
}) => {
	const watch = watchPage(page);
	await forceEnglish(page);
	await signUp(page, uniqueEmail("voice-native"));
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

	// The probe runs on open, so quick add must still be closed while the real
	// API is checked for. Presence only: available() is left to the app's own
	// probe, which is the call under test.
	const input = page.getByTestId("quickadd-input");
	await expect(input).toHaveCount(0);
	const api = await page.evaluate(() => {
		const ctor: unknown = Reflect.get(window, "SpeechRecognition");
		return {
			secureContext: window.isSecureContext,
			nativeShell: "NativeDitero" in window,
			constructor: typeof ctor,
			available:
				typeof ctor === "function"
					? typeof Reflect.get(ctor, "available")
					: "missing",
		};
	});
	expect(api).toEqual({
		secureContext: true,
		nativeShell: false,
		constructor: "function",
		available: "function",
	});
	watch.assertAlive();

	await page.getByTestId("syntax-hint-open-quickadd").click();
	await expect(input).toBeVisible();
	const draft = `Native probe ${[...randomUUID().replaceAll("-", "")]
		.map((c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
		.join("")
		.slice(0, 16)}`;
	await input.fill(draft);

	// One status or error surface is on screen at a time; it must leave the
	// checking spinner for a native-derived state within the window.
	const surface = page.locator(
		'[data-testid="quickadd-voice-status"], [data-testid="quickadd-voice-error"]',
	);
	await expect
		.poll(
			async () => {
				watch.assertAlive();
				const texts = await surface.allTextContents();
				return texts.length === 1
					? texts[0]?.trim()
					: `${texts.length} surfaces`;
			},
			{
				message: `native availability result within ${NATIVE_COMPLETION_TIMEOUT}ms`,
				timeout: NATIVE_COMPLETION_TIMEOUT,
			},
		)
		.toMatch(TERMINAL);
	watch.assertAlive();

	const outcome = (await surface.innerText()).trim();
	await expect(page.getByText(CHECKING)).toHaveCount(0);
	await expect(
		page
			.getByTestId("quickadd-voice-error")
			.filter({ hasText: GENERIC_FAILURE }),
	).toHaveCount(0);
	const dictate = page.getByTestId("quickadd-voice-start");
	if (outcome === PRIVACY) {
		await expect(dictate).toBeEnabled();
		await expect(dictate).toHaveText("Dictate");
	} else {
		await expect(dictate.and(page.locator(":enabled"))).toHaveCount(0);
	}

	// The probe never touched the typed draft, and typed Enter still saves
	// exactly one task whatever the pack state is.
	await expect(input).toHaveValue(draft);
	await input.press("Enter");
	await expect(input).toHaveValue("");
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("quickadd-dialog")).toHaveCount(0);
	await expect(input).toHaveCount(0);
	const task = page
		.getByTestId("list")
		.getByRole("checkbox", { name: draft, exact: true });
	await expect(task).toHaveCount(1);
	await expect(task).toBeVisible();
	watch.assertAlive();
});
