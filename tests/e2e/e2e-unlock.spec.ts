import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { m } from "../../src/paraglide/messages.js";
import { goToSettings, signUp, uniqueEmail } from "./helpers.ts";

// M-E2E Task 11, shell flow 2. Unlock is demand-driven by design, and in Gate B
// the only demand that exists is the Settings panel: the attachment surfaces
// that would open a file are Gate C, so "picking a file prompts to unlock" and
// "a locked attachment renders its placeholder" are asserted with them.
//
// Attribute selectors: Radix hideOthers() aria-hides the app root.

const PASSPHRASE = "correct horse battery staple";
const DERIVE_TIMEOUT = 30_000;

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

const status = (page: Page) => page.locator('[data-testid="e2e-status"]');

async function enroll(page: Page): Promise<void> {
	await page.locator('[data-testid="e2e-setup"]').click();
	await page.locator('[data-testid="e2e-passphrase"]').fill(PASSPHRASE);
	await page.locator('[data-testid="e2e-passphrase-confirm"]').fill(PASSPHRASE);
	await page.locator('[data-testid="e2e-enroll-continue"]').click();
	const code = page.locator('[data-testid="e2e-recovery-code"]');
	await expect(code).toBeVisible({ timeout: DERIVE_TIMEOUT });
	const typed = (await code.innerText()).replace(/\s+/g, "-");
	await page.locator('[data-testid="e2e-recovery-confirm"]').fill(typed);
	await page.locator('[data-testid="e2e-recovery-submit"]').click();
	await page.locator('[data-testid="e2e-enroll-close"]').click({
		timeout: DERIVE_TIMEOUT,
	});
	await expect(page.locator('[data-testid="e2e-enroll-dialog"]')).toHaveCount(
		0,
	);
}

async function setUp(page: Page): Promise<void> {
	await signUp(page, uniqueEmail("e2e-unlock"));
	await goToSettings(page);
	await enroll(page);
	// Enrollment leaves the device unlocked: the passphrase was typed two panes
	// ago, so prompting for it again immediately would be absurd.
	await expect(status(page)).toHaveText(m.e2e_status_ready());
}

test("unlock: lock now returns to locked, and unlocking comes back", async ({
	page,
}) => {
	await setUp(page);
	await expectNoSeriousA11y(page, "encrypted files: ready");

	await page.locator('[data-testid="e2e-lock-now"]').click();
	await expect(status(page)).toHaveText(m.e2e_status_locked());
	// The controls that only make sense while unlocked are gone, so "locked" is
	// a real state and not just a changed label.
	await expect(page.locator('[data-testid="e2e-lock-now"]')).toHaveCount(0);
	await expect(page.locator('[data-testid="e2e-autolock"]')).toHaveCount(0);

	await page.locator('[data-testid="e2e-unlock"]').click();
	await expect(page.locator('[data-testid="e2e-unlock-dialog"]')).toBeVisible();
	// Locking by hand is not a timeout, so the description must not blame one.
	await expect(
		page.locator('[data-testid="e2e-unlock-description"]'),
	).toHaveText(m.e2e_unlock_description());
	await expectNoSeriousA11y(page, "unlock dialog");

	await page.locator('[data-testid="e2e-unlock-passphrase"]').fill(PASSPHRASE);
	await page.locator('[data-testid="e2e-unlock-submit"]').click();
	await expect(page.locator('[data-testid="e2e-unlock-dialog"]')).toHaveCount(
		0,
		{ timeout: DERIVE_TIMEOUT },
	);
	await expect(status(page)).toHaveText(m.e2e_status_ready());
});

test("unlock: a wrong passphrase is named and does not clear the field", async ({
	page,
}) => {
	await setUp(page);
	await page.locator('[data-testid="e2e-lock-now"]').click();
	await page.locator('[data-testid="e2e-unlock"]').click();

	const field = page.locator('[data-testid="e2e-unlock-passphrase"]');
	await field.fill("not the passphrase");
	await page.locator('[data-testid="e2e-unlock-submit"]').click();

	await expect(page.locator('[data-testid="e2e-unlock-error"]')).toHaveText(
		m.e2e_unlock_wrong_passphrase(),
		{ timeout: DERIVE_TIMEOUT },
	);
	// Retyping a long passphrase because the app threw it away is the failure
	// mode this guards; there is no attempt counter and no lockout either,
	// because the check is local and a counter would be a lie.
	await expect(field).toHaveValue("not the passphrase");
	await expect(page.locator('[data-testid="e2e-unlock-dialog"]')).toBeVisible();

	// Still locked, so the wrong passphrase did not half-open anything.
	await page.keyboard.press("Escape");
	await expect(status(page)).toHaveText(m.e2e_status_locked());
});

test("unlock: a remembered device does not re-prompt after a reload", async ({
	page,
}) => {
	await setUp(page);

	await page.reload();
	await goToSettings(page);
	// The whole reason device storage exists. Nothing was typed after the
	// reload, so a ready state here can only have come from the stored key.
	await expect(status(page)).toHaveText(m.e2e_status_ready(), {
		timeout: DERIVE_TIMEOUT,
	});
	await expect(page.locator('[data-testid="e2e-unlock-dialog"]')).toHaveCount(
		0,
	);
});

test("unlock: lock now survives a reload as locked, not as unenrolled", async ({
	page,
}) => {
	await setUp(page);
	await page.locator('[data-testid="e2e-lock-now"]').click();
	await expect(status(page)).toHaveText(m.e2e_status_locked());

	await page.reload();
	await goToSettings(page);
	// Locking is not revoking: the stored key is still there, so the panel must
	// come back ready rather than demanding the passphrase again. This is the
	// pair to the test above -- together they show the stored record survives a
	// manual lock and is what a reload restores from.
	await expect(status(page)).toHaveText(m.e2e_status_ready(), {
		timeout: DERIVE_TIMEOUT,
	});
});

test("unlock: declining to remember means the next reload is locked", async ({
	page,
}) => {
	await setUp(page);
	await page.locator('[data-testid="e2e-lock-now"]').click();
	await page.locator('[data-testid="e2e-unlock"]').click();

	// Unchecking must actively revoke the record enrollment already stored, not
	// merely skip writing a new one -- otherwise the control works in one
	// direction only and a shared computer stays remembered.
	await page.locator('[data-testid="e2e-unlock-remember"]').click();
	await page.locator('[data-testid="e2e-unlock-passphrase"]').fill(PASSPHRASE);
	await page.locator('[data-testid="e2e-unlock-submit"]').click();
	await expect(status(page)).toHaveText(m.e2e_status_ready(), {
		timeout: DERIVE_TIMEOUT,
	});

	await page.reload();
	await goToSettings(page);
	await expect(status(page)).toHaveText(m.e2e_status_locked(), {
		timeout: DERIVE_TIMEOUT,
	});
});

test("unlock: the auto-lock choice persists across a reload", async ({
	page,
}) => {
	await setUp(page);

	await page.locator('[data-testid="e2e-autolock"]').click();
	await page.getByRole("option", { name: m.e2e_autolock_8h() }).click();
	await expect(page.locator('[data-testid="e2e-autolock"]')).toHaveText(
		m.e2e_autolock_8h(),
	);

	await page.reload();
	await goToSettings(page);
	// A synced preference, not a local one: #160 was exactly this bug for the
	// theme, where a per-device hint masked a column that never round-tripped.
	await expect(page.locator('[data-testid="e2e-autolock"]')).toHaveText(
		m.e2e_autolock_8h(),
		{ timeout: DERIVE_TIMEOUT },
	);
});
