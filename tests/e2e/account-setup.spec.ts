import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import type { AccountSetupRequest } from "../../src/domain/account-setup.ts";
import type * as Probe from "./account-setup-browser.tsx";
import { goToSettings, signUp, uniqueEmail, webOrigin } from "./helpers.ts";

test.setTimeout(90_000);
const panel = (page: Page) =>
	page.locator('fieldset[aria-label="Set up your space"]');
const password = "pw-123456";
function database() {
	const connectionString = process.env.E2E_DATABASE_URL;
	if (!connectionString) throw new Error("E2E_DATABASE_URL is required");
	return new Pool({ connectionString });
}
async function serverState(userID: string) {
	const pool = database();
	try {
		const row = (
			await pool.query(
				"select outcome,revision,latest_receipt receipt,generated_ids ids from account_setup where id=$1",
				[userID],
			)
		).rows[0];
		const counts = (
			await pool.query(
				`select
   (select count(*)::int from list where owner_id=$1) lists,
   (select count(*)::int from task t join list l on l.id=t.list_id where l.owner_id=$1) tasks,
   (select count(*)::int from dashboard where owner_id=$1) dashboards`,
				[userID],
			)
		).rows[0];
		return { row, counts };
	} finally {
		await pool.end();
	}
}
async function openSetup(page: Page) {
	await page.goto(`${webOrigin()}/setup`);
	await expect(panel(page)).toBeVisible();
	await expect(
		panel(page).getByRole("button", { name: "Continue", exact: true }),
	).toBeEnabled();
}
async function applyReview(page: Page, applyLabel = "Add starter content") {
	await panel(page)
		.getByRole("button", { name: "Continue", exact: true })
		.click();
	await panel(page)
		.getByRole("button", { name: applyLabel, exact: true })
		.click();
	await expect(
		panel(page).getByText("Your space is ready", { exact: true }),
	).toBeVisible();
}
async function assertFocusVisible(page: Page, target: Locator) {
	await expect(target).toBeFocused();
	const box = await target.boundingBox();
	if (!box) throw new Error("Focused setup heading has no bounds");
	const viewport = page.viewportSize();
	if (!viewport) throw new Error("Focus check requires an explicit viewport");
	expect(box.y).toBeGreaterThanOrEqual(0);
	expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
	const nav = (await page.getByTestId("settings-nav").count())
		? await page.getByTestId("settings-nav").boundingBox()
		: null;
	if (nav && box.x < nav.x + nav.width && box.x + box.width > nav.x)
		expect(box.y).toBeGreaterThanOrEqual(nav.y + nav.height);
}
async function capture(
	page: Page,
	name: string,
	target = panel(page).getByRole("heading", {
		name: "Set up your space",
		exact: true,
	}),
) {
	await expect(target).toBeVisible();
	await target.evaluate((element) => {
		const box = element.getBoundingClientRect();
		const nav = document
			.querySelector('[data-testid="settings-nav"]')
			?.getBoundingClientRect();
		const overlaps = nav && box.x < nav.right && box.right > nav.x;
		window.scrollTo({
			top: window.scrollY + box.top - (overlaps ? nav.height + 16 : 16),
			behavior: "instant",
		});
	});
	const targetBox = await target.boundingBox();
	if (!targetBox) throw new Error("Capture target has no bounds");
	expect(targetBox.y).toBeGreaterThanOrEqual(0);
	const navBox = (await page.getByTestId("settings-nav").count())
		? await page.getByTestId("settings-nav").boundingBox()
		: null;
	if (
		navBox &&
		targetBox.x < navBox.x + navBox.width &&
		targetBox.x + targetBox.width > navBox.x
	)
		expect(targetBox.y).toBeGreaterThanOrEqual(navBox.y + navBox.height);
	await page.evaluate(() => document.fonts.ready);
	const violations = (
		await new AxeBuilder({ page })
			.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
			.analyze()
	).violations;
	expect(
		violations.filter(
			(item) => item.impact === "serious" || item.impact === "critical",
		),
	).toEqual([]);
	const bounds = await ((await panel(page).count())
		? panel(page)
		: target
	).boundingBox();
	if (!bounds) throw new Error("Setup panel has no bounds");
	const width = page.viewportSize()?.width;
	if (!width) throw new Error("Screenshot requires an explicit viewport");
	expect(bounds.x).toBeGreaterThanOrEqual(0);
	expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth),
	).toBeLessThanOrEqual(width + 1);
	const path = test.info().outputPath(`${name}.png`);
	for (const button of await panel(page).getByRole("button").all()) {
		const box = await button.boundingBox();
		if (box) expect(box.height).toBeGreaterThanOrEqual(44);
	}
	await page.screenshot({ path, fullPage: false });
	await test.info().attach(name, { path, contentType: "image/png" });
}
async function mountProbe(page: Page, userID: string, email: string) {
	// Preserve the real app's loaded styles in this test-only component fixture.
	const styles = await page
		.locator('style, link[rel="stylesheet"]')
		.evaluateAll((nodes) => nodes.map((node) => node.outerHTML).join(""));
	await page.route("**/__account-setup-probe", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Setup probe</title>${styles}</head><body></body></html>`,
		}),
	);
	await page.goto(`${webOrigin()}/__account-setup-probe`);
	if (process.env.E2E_BROWSER_MODE !== "compiled")
		await page.addScriptTag({
			type: "module",
			content:
				'import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;',
		});
	await page.evaluate(
		async ({ userID, email }) => {
			const modulePath = "/tests/e2e/account-setup-browser.tsx";
			const sdk = (await import(modulePath)) as typeof Probe;
			sdk.mount(userID, email);
		},
		{ userID, email },
	);
	await expect.poll(async () => (await readProbe(page)).complete).toBe(true);
	await expect.poll(async () => (await readProbe(page)).online).toBe(true);
}
async function readProbe(page: Page) {
	return page.evaluate(async () => {
		const modulePath = "/tests/e2e/account-setup-browser.tsx";
		return ((await import(modulePath)) as typeof Probe).snapshot();
	});
}
async function chooseProbe(page: Page, mode: AccountSetupRequest["mode"]) {
	await page.evaluate(async (mode) => {
		const modulePath = "/tests/e2e/account-setup-browser.tsx";
		await ((await import(modulePath)) as typeof Probe).submitChoice(mode);
	}, mode);
}
async function control(
	page: Page,
	action:
		| "resume"
		| "retry"
		| "fresh"
		| "retire"
		| "injectNextAcknowledgementError",
) {
	await page.evaluate(async (action) => {
		const modulePath = "/tests/e2e/account-setup-browser.tsx";
		await ((await import(modulePath)) as typeof Probe)[action]();
	}, action);
}
async function ownRows(
	page: Page,
	ownID: string,
	foreignID: string,
	revision: number,
) {
	await expect
		.poll(async () => {
			const value = await readProbe(page);
			return {
				userID: value.userID,
				complete: value.complete,
				rows: value.rows?.map((row) => ({
					id: row.id,
					revision: row.revision,
				})),
			};
		})
		.toEqual({
			userID: ownID,
			complete: true,
			rows: [{ id: ownID, revision }],
		});
	expect(
		(await readProbe(page)).rows?.some((row) => row.id === foreignID),
	).toBe(false);
}

test("desktop Basic previews, commits once, and reopens read-only", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 1000 });
	const userID = await signUp(page, uniqueEmail("setup-basic"));
	await openSetup(page);
	await expect(
		panel(page).getByText(
			"Dashboard values reflect the tasks you can access.",
			{ exact: true },
		),
	).toBeVisible();
	await capture(page, "setup-desktop-choices");
	await panel(page)
		.getByRole("button", { name: "Continue", exact: true })
		.click();
	await assertFocusVisible(
		page,
		panel(page).getByRole("heading", {
			name: "Review your starting content",
			exact: true,
		}),
	);
	await capture(page, "setup-desktop-review");
	await capture(
		page,
		"setup-desktop-review-footer",
		panel(page).locator("footer"),
	);
	await panel(page)
		.getByRole("button", { name: "Add starter content", exact: true })
		.click();
	await expect(
		panel(page).getByText("Your space is ready", { exact: true }),
	).toBeVisible();
	expect((await serverState(userID)).counts).toEqual({
		lists: 2,
		tasks: 16,
		dashboards: 1,
	});
	const committed = await serverState(userID);
	await capture(page, "setup-desktop-completed");
	await page.reload();
	await expect(
		panel(page).getByText("Your space is ready", { exact: true }),
	).toBeVisible();
	expect(await serverState(userID)).toEqual(committed);
	await expect(
		panel(page).getByRole("button", {
			name: "Add starter content",
			exact: true,
		}),
	).toHaveCount(0);
});
test("mobile Guided rejects an empty selection and adds only Packing", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const userID = await signUp(page, uniqueEmail("setup-guided"));
	await openSetup(page);
	await expect(
		panel(page).getByRole("radio", { name: /^Basic/ }),
	).toBeChecked();
	await capture(page, "setup-mobile-basic-choices");
	await panel(page)
		.getByRole("radio", { name: /^Guided/ })
		.check();
	await panel(page)
		.getByRole("checkbox", { name: /^Shopping/ })
		.uncheck();
	await panel(page)
		.getByRole("checkbox", { name: /^Cleaning/ })
		.uncheck();
	await panel(page)
		.getByRole("checkbox", { name: "Personal dashboard", exact: true })
		.uncheck();
	await expect(
		panel(page).getByRole("button", { name: "Continue", exact: true }),
	).toBeDisabled();
	await panel(page)
		.getByRole("checkbox", { name: /^Packing/ })
		.check();
	await expect(
		panel(page).getByText(
			"Dashboard values reflect the tasks you can access.",
			{ exact: true },
		),
	).toHaveCount(0);
	await capture(page, "setup-mobile-choices");
	await page.setViewportSize({ width: 1280, height: 1000 });
	await expect(
		panel(page).getByRole("checkbox", { name: /^Packing/ }),
	).toBeChecked();
	await capture(page, "setup-guided-desktop-choices");
	await page.setViewportSize({ width: 390, height: 844 });
	await panel(page)
		.getByRole("button", { name: "Continue", exact: true })
		.click();
	const reviewHeading = panel(page).getByRole("heading", {
		name: "Review your starting content",
		exact: true,
	});
	await assertFocusVisible(page, reviewHeading);
	await capture(page, "setup-mobile-review", reviewHeading);
	await capture(
		page,
		"setup-mobile-review-footer",
		panel(page).locator("footer"),
	);
	await panel(page).getByRole("button", { name: "Back", exact: true }).click();
	await assertFocusVisible(
		page,
		panel(page)
			.locator("legend")
			.filter({ hasText: "Choose a starting point" }),
	);
	await panel(page)
		.getByRole("button", { name: "Continue", exact: true })
		.click();
	await assertFocusVisible(page, reviewHeading);
	await panel(page)
		.getByRole("button", { name: "Add starter content", exact: true })
		.click();
	await expect(
		panel(page).getByText("Your space is ready", { exact: true }),
	).toBeVisible();
	expect((await serverState(userID)).counts).toEqual({
		lists: 1,
		tasks: 8,
		dashboards: 0,
	});
	expect((await serverState(userID)).row.receipt.request).toMatchObject({
		mode: "guided",
		starterKeys: ["packing"],
		dashboard: false,
	});
	await expect(
		panel(page).getByText(
			"Dashboard values reflect the tasks you can access.",
			{ exact: true },
		),
	).toHaveCount(0);
	await capture(page, "setup-mobile-completed");
});
for (const mode of ["custom", "skip"] as const)
	test(`${mode} creates no content and reopening permits only an explicit starter choice`, async ({
		page,
	}) => {
		const userID = await signUp(page, uniqueEmail(`setup-${mode}`));
		await openSetup(page);
		if (mode === "custom") {
			await panel(page)
				.getByRole("radio", { name: /^Custom/ })
				.check();
			await panel(page)
				.getByRole("button", { name: "Continue", exact: true })
				.click();
			await expect(
				panel(page).getByText("No lists or tasks will be added.", {
					exact: true,
				}),
			).toBeVisible();
			await expect(
				panel(page).getByRole("button", { name: "Start empty", exact: true }),
			).toBeEnabled();
			await expect(
				panel(page).getByRole("button", {
					name: "Add starter content",
					exact: true,
				}),
			).toHaveCount(0);
			await capture(page, "setup-custom-empty-review");
			await panel(page)
				.getByRole("button", { name: "Start empty", exact: true })
				.click();
			await expect(
				panel(page).getByText("Your space is ready", { exact: true }),
			).toBeVisible();
		} else {
			await panel(page)
				.getByRole("button", { name: "Skip for now", exact: true })
				.click();
			await expect(
				panel(page).getByText("Your space is ready", { exact: true }),
			).toBeVisible();
		}
		expect((await serverState(userID)).counts).toEqual({
			lists: 0,
			tasks: 0,
			dashboards: 0,
		});
		await expect(
			panel(page).getByText(
				"Dashboard values reflect the tasks you can access.",
				{ exact: true },
			),
		).toHaveCount(0);
		await capture(page, `setup-${mode}-completed`);
		await panel(page)
			.getByRole("button", { name: "Open Ditero", exact: true })
			.click();
		await goToSettings(page);
		await page
			.getByRole("button", { name: "Choose starter content", exact: true })
			.click();
		await expect(
			panel(page).getByText("Your space is ready", { exact: true }),
		).toBeVisible();
		await panel(page)
			.getByRole("button", { name: "Choose starter content", exact: true })
			.click();
		await expect(
			panel(page).getByRole("radio", { name: /^Custom/ }),
		).toBeDisabled();
		await expect(
			panel(page).getByRole("button", { name: "Skip for now", exact: true }),
		).toBeDisabled();
		await expect(
			panel(page).getByText(
				"You already chose an empty start. You can add starter content now.",
				{ exact: true },
			),
		).toBeVisible();
		await capture(page, `setup-${mode}-disabled-reopen`);
		await applyReview(page);
		expect(Number((await serverState(userID)).row.revision)).toBe(2);
	});
test("offline controls never dispatch or enqueue a setup request", async ({
	page,
	context,
}) => {
	const email = uniqueEmail("setup-offline");
	const userID = await signUp(page, email);
	await mountProbe(page, userID, email);
	const before = await serverState(userID);
	const requestId = (await readProbe(page)).requestId;
	await context.setOffline(true);
	try {
		await expect.poll(async () => (await readProbe(page)).online).toBe(false);
		await chooseProbe(page, "basic");
		await control(page, "retry");
		await control(page, "resume");
		expect((await readProbe(page)).writes).toEqual([]);
		expect((await readProbe(page)).requestId).toBe(requestId);
		expect((await readProbe(page)).request).toBeNull();
		expect(await serverState(userID)).toEqual(before);
		await expect(panel(page).getByRole("alert")).toHaveText(
			"Starter setup needs a connection. Reconnect before adding content.",
		);
		await capture(page, "setup-fixture-real-offline-error");
	} finally {
		await context.setOffline(false);
	}
	await expect.poll(async () => (await readProbe(page)).online).toBe(true);
	await chooseProbe(page, "basic");
	await expect
		.poll(async () => (await readProbe(page)).state)
		.toBe("completed");
	expect((await readProbe(page)).writes[0].requestId).toBe(requestId);
});
for (const recovery of ["resume", "retry"] as const)
	test(`injected acknowledgement error: ${recovery} uses the exact real committed receipt`, async ({
		page,
	}) => {
		const email = uniqueEmail(`setup-ack-${recovery}`);
		const userID = await signUp(page, email);
		await mountProbe(page, userID, email);
		await control(page, "injectNextAcknowledgementError");
		await chooseProbe(page, "basic");
		await expect
			.poll(async () => (await readProbe(page)).state)
			.toBe("uncertain");
		await expect(
			panel(page).getByRole("button", {
				name: "Check server status",
				exact: true,
			}),
		).toBeEnabled();
		await expect(
			panel(page).getByRole("button", {
				name: "Retry this attempt",
				exact: true,
			}),
		).toBeEnabled();
		await expect(panel(page).getByRole("alert")).toHaveText(
			"Setup could not be confirmed. Check the status before trying again.",
		);
		await capture(page, `setup-fixture-injected-ack-${recovery}-uncertain`);
		const uncertain = await readProbe(page);
		expect(uncertain.acknowledgements).toEqual([
			{ requestId: uncertain.requestId, committed: true, injected: true },
		]);
		await expect
			.poll(async () => (await readProbe(page)).rows?.[0]?.revision)
			.toBe(1);
		const before = await serverState(userID);
		expect(before.row.receipt.request).toEqual(uncertain.request);
		await control(page, recovery);
		await expect
			.poll(async () => (await readProbe(page)).state)
			.toBe("completed");
		await capture(page, `setup-fixture-injected-ack-${recovery}-completed`);
		const recovered = await readProbe(page);
		expect(recovered.writes).toHaveLength(recovery === "resume" ? 1 : 2);
		expect(
			recovered.writes.every(
				(request) =>
					JSON.stringify(request) === JSON.stringify(uncertain.request),
			),
		).toBe(true);
		expect(await serverState(userID)).toEqual(before);
		await test.info().attach("injected-acknowledgement-control", {
			body: JSON.stringify(recovered),
			contentType: "application/json",
		});
	});
test("competing Basic and Custom attempts never merge choices or silently regenerate identity", async ({
	page,
	context,
}) => {
	const email = uniqueEmail("setup-competing");
	const userID = await signUp(page, email);
	const other = await context.newPage();
	try {
		await other.goto(`${webOrigin()}/setup`);
		await expect(panel(other)).toBeVisible();
		await expect
			.poll(() =>
				other.evaluate(() =>
					Array.from(document.styleSheets).some(
						(sheet) => sheet.cssRules.length > 0,
					),
				),
			)
			.toBe(true);
		await mountProbe(page, userID, email);
		await mountProbe(other, userID, email);
		const firstId = (await readProbe(page)).requestId;
		const secondId = (await readProbe(other)).requestId;
		await Promise.all([
			chooseProbe(page, "basic"),
			chooseProbe(other, "custom"),
		]);
		await expect
			.poll(async () =>
				[(await readProbe(page)).state, (await readProbe(other)).state].sort(),
			)
			.toEqual(["completed", "conflict"]);
		const conflicted =
			(await readProbe(page)).state === "conflict" ? page : other;
		await expect(panel(conflicted).getByRole("alert")).toHaveText(
			"Your setup changed in another session. Check its current status before continuing.",
		);
		await capture(conflicted, "setup-fixture-real-competing-conflict");
		const committed = await serverState(userID);
		expect([firstId, secondId]).toContain(
			committed.row.receipt.request.requestId,
		);
		expect(committed.counts).toEqual(
			committed.row.outcome === "completed"
				? { lists: 2, tasks: 16, dashboards: 1 }
				: { lists: 0, tasks: 0, dashboards: 0 },
		);
		expect((await readProbe(page)).requestId).toBe(firstId);
		expect((await readProbe(other)).requestId).toBe(secondId);
		await control(page, "resume");
		await control(other, "resume");
		expect(await serverState(userID)).toEqual(committed);
	} finally {
		await other.close();
	}
});
test("legacy remains eligible while any own managed marker denies and guardian rows do not", async ({
	browser,
}) => {
	const aliceContext = await browser.newContext();
	const bobContext = await browser.newContext();
	const pool = database();
	try {
		const alicePage = await aliceContext.newPage();
		const bobPage = await bobContext.newPage();
		const aliceEmail = uniqueEmail("setup-managed");
		const bobEmail = uniqueEmail("setup-legacy");
		const alice = await signUp(alicePage, aliceEmail);
		const bob = await signUp(bobPage, bobEmail);
		await pool.query(
			"insert into account_setup(id,outcome,revision) values($1,'legacy',0)",
			[bob],
		);
		await pool.query(
			"insert into managed_account(id,user_id,guardian_id,restricted) values($1,$2,$3,false)",
			[randomUUID(), alice, bob],
		);
		await mountProbe(alicePage, alice, aliceEmail);
		await mountProbe(bobPage, bob, bobEmail);
		await expect
			.poll(async () => (await readProbe(alicePage)).managed)
			.toBe(true);
		const managedMessage = alicePage.getByText(
			"A managed account cannot add starter content. Ask your guardian to organize your shared lists.",
			{ exact: true },
		);
		await expect(managedMessage).toBeVisible();
		await capture(
			alicePage,
			"setup-fixture-own-managed-marker",
			managedMessage,
		);
		await chooseProbe(alicePage, "basic");
		expect((await readProbe(alicePage)).writes).toEqual([]);
		await expect
			.poll(async () => (await readProbe(bobPage)).outcome)
			.toBe("legacy");
		expect((await readProbe(bobPage)).managed).toBe(false);
		await chooseProbe(bobPage, "skip");
		await expect
			.poll(async () => (await readProbe(bobPage)).state)
			.toBe("completed");
		expect((await serverState(alice)).counts).toEqual({
			lists: 0,
			tasks: 0,
			dashboards: 0,
		});
	} finally {
		await pool.end();
		await aliceContext.close();
		await bobContext.close();
	}
});
test("reserved managed email denies setup before a managed marker exists", async ({
	page,
}) => {
	const email = `${randomUUID()}@managed.invalid`;
	const userID = await signUp(page, email);
	await page.goto(`${webOrigin()}/setup`);
	await expect(
		page.getByText(
			"A managed account cannot add starter content. Ask your guardian to organize your shared lists.",
			{ exact: true },
		),
	).toBeVisible();
	await capture(
		page,
		"setup-reserved-managed-email",
		page.getByText(
			"A managed account cannot add starter content. Ask your guardian to organize your shared lists.",
			{ exact: true },
		),
	);
	await expect(
		page.getByRole("button", { name: "Add starter content", exact: true }),
	).toHaveCount(0);
	expect((await serverState(userID)).counts).toEqual({
		lists: 0,
		tasks: 0,
		dashboards: 0,
	});
});
test("real provider queries isolate two owners through initial query snapshots, CDC, and authenticated account changes", async ({
	browser,
}) => {
	const first = await browser.newContext();
	const second = await browser.newContext();
	const pool = database();
	try {
		const pa = await first.newPage();
		const pb = await second.newPage();
		const emailA = uniqueEmail("setup-owner-a");
		const emailB = uniqueEmail("setup-owner-b");
		const a = await signUp(pa, emailA);
		const b = await signUp(pb, emailB);
		// These rows predate the browser queries, not the Zero replica's startup copy.
		await pool.query(
			"insert into account_setup(id,outcome,revision) values($1,'pending',0),($2,'pending',0)",
			[a, b],
		);
		await mountProbe(pa, a, emailA);
		await mountProbe(pb, b, emailB);
		await ownRows(pa, a, b, 0);
		await ownRows(pb, b, a, 0);
		await chooseProbe(pa, "custom");
		await chooseProbe(pb, "custom");
		await ownRows(pa, a, b, 1);
		await ownRows(pb, b, a, 1);
		await control(pb, "fresh");
		await chooseProbe(pb, "basic");
		await ownRows(pb, b, a, 2);
		await ownRows(pa, a, b, 1);
		await control(pa, "retire");
		const origin = webOrigin();
		const signedOut = await pa.request.post(`${origin}/api/auth/sign-out`, {
			headers: { Origin: origin },
			data: {},
		});
		expect(signedOut.ok()).toBe(true);
		const signedIn = await pa.request.post(`${origin}/api/auth/sign-in/email`, {
			headers: { Origin: origin },
			data: { email: emailB, password },
		});
		expect(signedIn.ok()).toBe(true);
		expect((await signedIn.json()).user.id).toBe(b);
		await pa.evaluate(
			async ({ b, emailB }) => {
				const modulePath = "/tests/e2e/account-setup-browser.tsx";
				((await import(modulePath)) as typeof Probe).mount(b, emailB);
			},
			{ b, emailB },
		);
		await ownRows(pa, b, a, 2);
		expect((await readProbe(pa)).request).toBeNull();
		expect((await readProbe(pa)).writes).toEqual([]);
	} finally {
		await pool.end();
		await first.close();
		await second.close();
	}
});
