import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { m } from "../../src/paraglide/messages.js";
import { goToSettings, signUp, uniqueEmail } from "./helpers.ts";

// M-E2E Task 10, shell flow 1. Driven from the Settings entry point
// (shell section 9), which is the flow's second trigger and the only one that
// exists before the attachment surfaces land in Gate C. The primary trigger --
// picking a file, with the file surviving the wizard and uploading on
// completion -- is asserted with those surfaces, since neither the picker nor
// the upload endpoint exists yet.
//
// Attribute selectors throughout: Radix calls hideOthers(), which aria-hides
// the app root, and Playwright's role engine skips aria-hidden subtrees.

const PASSPHRASE = "correct horse battery staple";

async function expectNoSeriousA11y(page: Page, surface: string): Promise<void> {
	await page.addStyleTag({
		content:
			"*,*::before,*::after{animation:none!important;transition:none!important}",
	});
	const { violations } = await new AxeBuilder({ page }).analyze();
	const serious = violations.filter(
		(v) => v.impact === "serious" || v.impact === "critical",
	);
	if (serious.length > 0)
		console.error(
			`a11y[${surface}] serious/critical:`,
			JSON.stringify(
				serious.map((v) => ({ id: v.id, nodes: v.nodes.length })),
				null,
				2,
			),
		);
	expect(serious, `serious/critical a11y violations on ${surface}`).toEqual([]);
}

async function openWizard(page: Page): Promise<void> {
	await signUp(page, uniqueEmail("e2e-enroll"));
	await goToSettings(page);
	await expect(page.locator('[data-testid="e2e-setup"]')).toBeVisible();
	await page.locator('[data-testid="e2e-setup"]').click();
	await expect(page.locator('[data-testid="e2e-enroll-dialog"]')).toBeVisible();
}

// Argon2id at m=64 MiB runs twice on Continue, in a worker, on a loaded CI box.
const DERIVE_TIMEOUT = 30_000;

async function reachRecoveryPane(page: Page): Promise<string> {
	await page.locator('[data-testid="e2e-passphrase"]').fill(PASSPHRASE);
	await page.locator('[data-testid="e2e-passphrase-confirm"]').fill(PASSPHRASE);
	await page.locator('[data-testid="e2e-enroll-continue"]').click();
	const code = page.locator('[data-testid="e2e-recovery-code"]');
	await expect(code).toBeVisible({ timeout: DERIVE_TIMEOUT });
	return (await code.innerText()).replace(/\s+/g, "-");
}

test("enrollment: passphrase floor, recovery code, confirm, and the identity lands", async ({
	page,
}) => {
	await openWizard(page);

	// The consequential copy is present and is not a footnote the user can miss.
	await expect(page.locator('[data-testid="e2e-no-reset-note"]')).toBeVisible();
	await expect(
		page.getByText(m.e2e_enroll_not_account_password()),
	).toBeVisible();

	await expectNoSeriousA11y(page, "enroll pane 1");

	// A weak passphrase is refused with a reason, not silently ignored.
	await page.locator('[data-testid="e2e-passphrase"]').fill("short");
	await page.locator('[data-testid="e2e-passphrase-confirm"]').fill("short");
	await page.locator('[data-testid="e2e-enroll-continue"]').click();
	await expect(page.locator('[data-testid="e2e-passphrase-error"]')).toHaveText(
		m.e2e_passphrase_too_short(),
	);
	// Still on pane 1: the presence assertion that keeps the absence below
	// meaningful.
	await expect(page.locator('[data-testid="e2e-passphrase"]')).toBeVisible();

	// A mismatch is a different reason, so the two are not one generic error.
	await page.locator('[data-testid="e2e-passphrase"]').fill(PASSPHRASE);
	await page
		.locator('[data-testid="e2e-passphrase-confirm"]')
		.fill(`${PASSPHRASE}!`);
	await page.locator('[data-testid="e2e-enroll-continue"]').click();
	await expect(page.locator('[data-testid="e2e-passphrase-error"]')).toHaveText(
		m.e2e_passphrase_mismatch(),
	);

	const code = await reachRecoveryPane(page);

	// Seven groups: six of payload plus one checksum (recovery-code.ts V1).
	await expect(page.locator('[data-testid="e2e-recovery-group"]')).toHaveCount(
		7,
	);

	// Focus order, shell flow 1: the code block, not the Copy button. A screen
	// reader must reach the code it is here to save before any control that
	// acts on it. Asserted rather than assumed -- the first implementation
	// focused a wrapper with no tabIndex, which is a silent no-op.
	await expect(page.locator('[data-testid="e2e-recovery-code"]')).toBeFocused();
	await expectNoSeriousA11y(page, "enroll pane 2");

	// Continuing is blocked until the code is typed back. Empty submit stays
	// on the pane; a wrong code names the checksum rather than the mismatch.
	await expect(
		page.locator('[data-testid="e2e-recovery-submit"]'),
	).toBeDisabled();

	await page
		.locator('[data-testid="e2e-recovery-confirm"]')
		.fill("00000-00000-00000-00000-00000-00000-00000");
	await page.locator('[data-testid="e2e-recovery-submit"]').click();
	await expect(page.locator('[data-testid="e2e-recovery-error"]')).toHaveText(
		m.e2e_recovery_confirm_checksum(),
	);
	// Nothing was persisted by a failed confirm: still on pane 2.
	await expect(page.locator('[data-testid="e2e-recovery-code"]')).toBeVisible();

	await page.locator('[data-testid="e2e-recovery-confirm"]').fill(code);
	await page.locator('[data-testid="e2e-recovery-submit"]').click();

	await expect(page.locator('[data-testid="e2e-enroll-close"]')).toBeVisible({
		timeout: DERIVE_TIMEOUT,
	});
	await expect(page.getByText(m.e2e_enroll_done_body())).toBeVisible();
	// The enroll POST is the only thing that could have produced this pane
	// without an error, but assert the error is absent anyway: the done pane
	// renders for both outcomes.
	await expect(page.locator('[data-testid="e2e-enroll-error"]')).toHaveCount(0);
	await expectNoSeriousA11y(page, "enroll pane 3");

	await page.locator('[data-testid="e2e-enroll-close"]').click();
	// DERIVE_TIMEOUT, not the 7s default: this sits downstream of the enroll
	// POST, the adoptPrivateKey re-read and the IndexedDB store, all of which
	// run while the close click is being handled. It timed out at 7000ms once
	// in a loaded full-suite run and never in an isolated one -- position-
	// dependent, like #128, not flaky.
	await expect(page.locator('[data-testid="e2e-enroll-dialog"]')).toHaveCount(
		0,
		{ timeout: DERIVE_TIMEOUT },
	);

	// The panel re-reads /api/e2e/identity and stops offering setup, which is
	// the only client-visible proof the row was written.
	await expect(page.locator('[data-testid="e2e-setup"]')).toHaveCount(0);
	await expect(
		page.locator('[data-testid="e2e-no-reset-note-settings"]'),
	).toBeVisible();
});

test("enrollment: the recovery code survives a copy round-trip", async ({
	page,
	context,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await openWizard(page);
	const code = await reachRecoveryPane(page);

	await page.locator('[data-testid="e2e-recovery-copy"]').click();
	const clipboard = await page.evaluate(() => navigator.clipboard.readText());
	// The clipboard must carry the hyphenated DISPLAY form. The canonical form
	// derives a different KEK, so a copy that silently strips separators would
	// hand the user a string that never unlocks anything.
	expect(clipboard).toBe(code);
	expect(clipboard).toContain("-");
});

test("enrollment: abandoning at the recovery pane persists nothing", async ({
	page,
}) => {
	await openWizard(page);
	await reachRecoveryPane(page);

	await page.keyboard.press("Escape");
	// DERIVE_TIMEOUT, not the 7s default: this sits downstream of the enroll
	// POST, the adoptPrivateKey re-read and the IndexedDB store, all of which
	// run while the close click is being handled. It timed out at 7000ms once
	// in a loaded full-suite run and never in an isolated one -- position-
	// dependent, like #128, not flaky.
	await expect(page.locator('[data-testid="e2e-enroll-dialog"]')).toHaveCount(
		0,
		{ timeout: DERIVE_TIMEOUT },
	);

	// Reopening starts from pane 1, and the setup entry point is still offered
	// -- so no identity was written by reaching pane 2.
	await expect(page.locator('[data-testid="e2e-setup"]')).toBeVisible();
	await page.locator('[data-testid="e2e-setup"]').click();
	await expect(page.locator('[data-testid="e2e-passphrase"]')).toBeVisible();
	await expect(page.locator('[data-testid="e2e-recovery-code"]')).toHaveCount(
		0,
	);
});
