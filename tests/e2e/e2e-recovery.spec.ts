import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { generateRecoveryCode } from "../../src/domain/e2e/recovery-code.ts";
import { m } from "../../src/paraglide/messages.js";
import { goToSettings, signUp, uniqueEmail } from "./helpers.ts";

// M-E2E Task 12, shell flow 3 and section 4.2. Every assertion here is about
// what a rewrap leaves alone: recovery restores the SAME identity, a passphrase
// change leaves the printed code working, and a regenerated code kills the old
// one. Attribute selectors throughout: Radix hideOthers() aria-hides the app
// root, so a getByRole locator is unresolvable while a dialog is open.

const PASSPHRASE = "correct horse battery staple";
const NEXT_PASSPHRASE = "a different long passphrase";
const DERIVE_TIMEOUT = 30_000;

const status = (page: Page) => page.locator('[data-testid="e2e-status"]');

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

/** The displayed code, in the hyphenated form the field accepts back. */
async function readCode(page: Page, testId: string): Promise<string> {
	const code = page.locator(`[data-testid="${testId}"]`);
	await expect(code).toBeVisible({ timeout: DERIVE_TIMEOUT });
	return (await code.innerText()).replace(/\s+/g, "-");
}

async function enroll(page: Page): Promise<string> {
	await page.locator('[data-testid="e2e-setup"]').click();
	await page.locator('[data-testid="e2e-passphrase"]').fill(PASSPHRASE);
	await page.locator('[data-testid="e2e-passphrase-confirm"]').fill(PASSPHRASE);
	await page.locator('[data-testid="e2e-enroll-continue"]').click();
	const code = await readCode(page, "e2e-recovery-code");
	await page.locator('[data-testid="e2e-recovery-confirm"]').fill(code);
	await page.locator('[data-testid="e2e-recovery-submit"]').click();
	await page
		.locator('[data-testid="e2e-enroll-close"]')
		.click({ timeout: DERIVE_TIMEOUT });
	// DERIVE_TIMEOUT, not the 7s default: this sits downstream of the enroll
	// POST, the adoptPrivateKey re-read and the IndexedDB store, all of which
	// run while the close click is being handled. It timed out at 7000ms once
	// in a loaded full-suite run and never in an isolated one -- position-
	// dependent, like #128, not flaky.
	await expect(page.locator('[data-testid="e2e-enroll-dialog"]')).toHaveCount(
		0,
		{ timeout: DERIVE_TIMEOUT },
	);
	return code;
}

async function setUp(page: Page, label: string): Promise<string> {
	await signUp(page, uniqueEmail(label));
	await goToSettings(page);
	const code = await enroll(page);
	await expect(status(page)).toHaveText(m.e2e_status_ready());
	return code;
}

async function openUnlockDialog(page: Page): Promise<void> {
	await page.locator('[data-testid="e2e-lock-now"]').click();
	await expect(status(page)).toHaveText(m.e2e_status_locked());
	await page.locator('[data-testid="e2e-unlock"]').click();
	await expect(page.locator('[data-testid="e2e-unlock-dialog"]')).toBeVisible();
}

test("recovery: the code unlocks, and forces a new passphrase and a new code", async ({
	page,
}) => {
	const code = await setUp(page, "e2e-recover");
	await openUnlockDialog(page);

	await page.locator('[data-testid="e2e-use-recovery"]').click();
	await expect(page.locator('[data-testid="e2e-recover-code"]')).toBeVisible();
	await expectNoSeriousA11y(page, "recovery: code pane");

	await page.locator('[data-testid="e2e-recover-code"]').fill(code);
	await page.locator('[data-testid="e2e-recover-submit"]').click();

	// Unlocking with the code is not the end of the flow. Whoever got here has
	// demonstrated they do not know the passphrase, so a new one is mandatory.
	const reset = page.locator('[data-testid="e2e-recover-passphrase"]');
	await expect(reset).toBeVisible({ timeout: DERIVE_TIMEOUT });
	await expectNoSeriousA11y(page, "recovery: reset pane");
	await reset.fill(NEXT_PASSPHRASE);
	await page
		.locator('[data-testid="e2e-recover-passphrase-confirm"]')
		.fill(NEXT_PASSPHRASE);
	await page.locator('[data-testid="e2e-recover-reset-submit"]').click();

	const issued = await readCode(page, "e2e-recovery-code");
	// The code that got the user in has been through a text field and possibly
	// a clipboard, so it is replaced rather than left as a second live secret.
	expect(issued).not.toBe(code);
	await expect(
		page.locator('[data-testid="e2e-recover-must-confirm"]'),
	).toHaveText(m.e2e_recovery_must_confirm());

	// The rewrap has already landed, so this pane cannot be escaped: leaving
	// would strand the user with the only working code unseen.
	await page.keyboard.press("Escape");
	await expect(page.locator('[data-testid="e2e-unlock-dialog"]')).toBeVisible();

	await page.locator('[data-testid="e2e-recover-confirm"]').fill(issued);
	await page.locator('[data-testid="e2e-recover-confirm-submit"]').click();
	await expect(page.locator('[data-testid="e2e-unlock-dialog"]')).toHaveCount(
		0,
		{ timeout: DERIVE_TIMEOUT },
	);
	// Recovery ends unlocked on the SAME identity, not re-enrolled: a new
	// keypair would render every existing grant unopenable.
	await expect(status(page)).toHaveText(m.e2e_status_ready());

	// The new passphrase works and the old one does not, which is the whole
	// point of the reset pane.
	await openUnlockDialog(page);
	await page.locator('[data-testid="e2e-unlock-passphrase"]').fill(PASSPHRASE);
	await page.locator('[data-testid="e2e-unlock-submit"]').click();
	await expect(page.locator('[data-testid="e2e-unlock-error"]')).toHaveText(
		m.e2e_unlock_wrong_passphrase(),
		{ timeout: DERIVE_TIMEOUT },
	);
	await page
		.locator('[data-testid="e2e-unlock-passphrase"]')
		.fill(NEXT_PASSPHRASE);
	await page.locator('[data-testid="e2e-unlock-submit"]').click();
	await expect(status(page)).toHaveText(m.e2e_status_ready(), {
		timeout: DERIVE_TIMEOUT,
	});

	// And the issued code is the one that WORKS. Without this the pane could
	// display a freshly minted code it never stored, leaving the account
	// reachable only by the code the user was just told is dead.
	await openUnlockDialog(page);
	await page.locator('[data-testid="e2e-use-recovery"]').click();
	await page.locator('[data-testid="e2e-recover-code"]').fill(code);
	await page.locator('[data-testid="e2e-recover-submit"]').click();
	await expect(page.locator('[data-testid="e2e-recover-error"]')).toHaveText(
		m.e2e_recovery_wrong(),
		{ timeout: DERIVE_TIMEOUT },
	);
	await page.locator('[data-testid="e2e-recover-code"]').fill(issued);
	await page.locator('[data-testid="e2e-recover-submit"]').click();
	await expect(
		page.locator('[data-testid="e2e-recover-passphrase"]'),
	).toBeVisible({ timeout: DERIVE_TIMEOUT });
});

test("recovery: a wrong code is refused and changes nothing", async ({
	page,
}) => {
	const code = await setUp(page, "e2e-recover-wrong");
	await openUnlockDialog(page);
	await page.locator('[data-testid="e2e-use-recovery"]').click();

	// A genuinely valid code belonging to nobody, minted here rather than by
	// mangling this one: editing a character fails the CHECKSUM, which is a
	// different message and never reaches the derivation this test is about.
	const wrong = (await generateRecoveryCode()).display;
	expect(wrong).not.toBe(code);
	await page.locator('[data-testid="e2e-recover-code"]').fill(wrong);
	await page.locator('[data-testid="e2e-recover-submit"]').click();
	await expect(page.locator('[data-testid="e2e-recover-error"]')).toHaveText(
		m.e2e_recovery_wrong(),
		{ timeout: DERIVE_TIMEOUT },
	);
	// Still on the code pane: a failed code must not advance the flow.
	await expect(
		page.locator('[data-testid="e2e-recover-passphrase"]'),
	).toHaveCount(0);

	// The real code still works, so the failed attempt rewrapped nothing.
	await page.locator('[data-testid="e2e-recover-code"]').fill(code);
	await page.locator('[data-testid="e2e-recover-submit"]').click();
	await expect(
		page.locator('[data-testid="e2e-recover-passphrase"]'),
	).toBeVisible({ timeout: DERIVE_TIMEOUT });
});

test("settings: changing the passphrase leaves the recovery code working", async ({
	page,
}) => {
	const code = await setUp(page, "e2e-change-pass");

	await page.locator('[data-testid="e2e-change-passphrase"]').click();
	const dialog = page.locator('[data-testid="e2e-change-dialog"]');
	await expect(dialog).toBeVisible();
	await expectNoSeriousA11y(page, "change passphrase dialog");

	// The current passphrase is demanded even though the keyring is unlocked:
	// unlocked can mean this browser held a stored key.
	await page
		.locator('[data-testid="e2e-current-passphrase"]')
		.fill("wrong one");
	await page
		.locator('[data-testid="e2e-new-passphrase"]')
		.fill(NEXT_PASSPHRASE);
	await page
		.locator('[data-testid="e2e-new-passphrase-confirm"]')
		.fill(NEXT_PASSPHRASE);
	await page.locator('[data-testid="e2e-passphrase-dialog-submit"]').click();
	await expect(
		page.locator('[data-testid="e2e-passphrase-dialog-error"]'),
	).toHaveText(m.e2e_unlock_wrong_passphrase(), { timeout: DERIVE_TIMEOUT });

	await page.locator('[data-testid="e2e-current-passphrase"]').fill(PASSPHRASE);
	await page.locator('[data-testid="e2e-passphrase-dialog-submit"]').click();
	await expect(
		page.locator('[data-testid="e2e-passphrase-dialog-done"]'),
	).toHaveText(m.e2e_change_passphrase_done(), { timeout: DERIVE_TIMEOUT });
	await page.locator('[data-testid="e2e-passphrase-dialog-close"]').click();

	// The promise the done message makes, tested rather than asserted in prose:
	// the code the user has on paper still opens the account.
	await openUnlockDialog(page);
	await page.locator('[data-testid="e2e-use-recovery"]').click();
	await page.locator('[data-testid="e2e-recover-code"]').fill(code);
	await page.locator('[data-testid="e2e-recover-submit"]').click();
	await expect(
		page.locator('[data-testid="e2e-recover-passphrase"]'),
	).toBeVisible({ timeout: DERIVE_TIMEOUT });
});

test("settings: regenerating a code retires the old one", async ({ page }) => {
	const code = await setUp(page, "e2e-regen");

	await page.locator('[data-testid="e2e-regenerate-recovery"]').click();
	const dialog = page.locator('[data-testid="e2e-regenerate-dialog"]');
	await expect(dialog).toBeVisible();
	// The warning is stated before the passphrase is typed, not after the old
	// code is already dead.
	await expect(
		page.locator('[data-testid="e2e-regenerate-warning"]'),
	).toHaveText(m.e2e_regenerate_warning());
	await expectNoSeriousA11y(page, "regenerate recovery dialog");

	await page.locator('[data-testid="e2e-current-passphrase"]').fill(PASSPHRASE);
	await page.locator('[data-testid="e2e-passphrase-dialog-submit"]').click();

	const issued = await readCode(page, "e2e-recovery-code");
	expect(issued).not.toBe(code);
	// The rewrap already landed, so this pane cannot be escaped either -- the
	// same guard as the recovery flow, in a different component.
	await page.keyboard.press("Escape");
	await expect(dialog).toBeVisible();
	await page.locator('[data-testid="e2e-regenerate-confirm"]').fill(issued);
	await page.locator('[data-testid="e2e-regenerate-confirm-submit"]').click();
	await expect(
		page.locator('[data-testid="e2e-passphrase-dialog-done"]'),
	).toHaveText(m.e2e_regenerate_done());
	await page.locator('[data-testid="e2e-passphrase-dialog-close"]').click();

	// The old code is dead and the new one lives. Asserting only the first
	// would pass against a rewrap that broke both.
	await openUnlockDialog(page);
	await page.locator('[data-testid="e2e-use-recovery"]').click();
	await page.locator('[data-testid="e2e-recover-code"]').fill(code);
	await page.locator('[data-testid="e2e-recover-submit"]').click();
	await expect(page.locator('[data-testid="e2e-recover-error"]')).toHaveText(
		m.e2e_recovery_wrong(),
		{ timeout: DERIVE_TIMEOUT },
	);

	await page.locator('[data-testid="e2e-recover-code"]').fill(issued);
	await page.locator('[data-testid="e2e-recover-submit"]').click();
	await expect(
		page.locator('[data-testid="e2e-recover-passphrase"]'),
	).toBeVisible({ timeout: DERIVE_TIMEOUT });
});
