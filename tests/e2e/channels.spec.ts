import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import {
	type Browser,
	expect,
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import { Pool } from "pg";

// M3b Task 16 e2e: the five-row channel settings surface, the SMTP mail path
// against a real loopback sink, the test-send ack round trip (durable through a
// reload, which is the whole reason ack_verified_at is a server column), and a
// live ack driven through the Discord interactions listener with a real signed
// POST -- the M3a in-app exit gate extended to an interactive provider, with an
// open Zero client watching the ack land and a seeded sibling terminate.
//
// Conventions (signUp/uniqueEmail/testid locators/frozen-frame axe, describe-
// level retries) mirror views.spec + notifications.spec.
//
// Provider chosen for the interactive ack: DISCORD. Its interactions endpoint's
// callback IS the HTTP response body (no egress at the ack step), so the whole
// round trip is hermetic -- Slack would post the message update to a pinned
// hooks.slack.com host this suite cannot stand up. ntfy is the delivery tap that
// carries the ack token to the wire; the disabled discord app-mode row supplies
// the signing key and channel binding the listener authorises against, without
// any discord.com traffic.
test.describe.configure({ retries: 2, timeout: 90_000 });

const PASSWORD = "pw-123456";
const SIGNUP_TIMEOUT = 30_000;
// Private, non-loopback ntfy stub (playwright.config): the SSRF boundary refuses
// loopback, so the tap binds a private interface and that one /32 is allowlisted.
const NTFY = process.env.E2E_NTFY_URL ?? "http://172.17.0.1:4599";
const NTFY_CAPTURED = `${NTFY}/_captured`;
// The SMTP deployment is API-only (no web app): the mail wire is asserted
// through an APIRequestContext, and the SMTP-less UI states render on the
// default web app against the shared DB.
const MAIL_API = process.env.E2E_MAIL_API_URL ?? "http://localhost:3001";
const SMTP_CAPTURE = process.env.E2E_SMTP_HTTP_URL ?? "http://127.0.0.1:4601";
// The interactions listener lives on the default app server, mounted ahead of
// the CORS hook; POSTed directly so no proxy rewrites the signed bytes.
const DISCORD_INTERACTIONS =
	"http://localhost:3000/api/notifications/discord/interactions";
const ACK_ROUTE = "http://localhost:3000/api/notifications/ack";

let emailSeq = 0;
function uniqueEmail(prefix: string): string {
	emailSeq += 1;
	return `${prefix}-${Date.now()}-${emailSeq}@t.dev`;
}

async function signUp(page: Page, email: string): Promise<void> {
	await page.goto("/");
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill(PASSWORD);
	await page.getByTestId("signup").click();
	await expect(page.getByTestId("workspace")).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
}

async function waitWorkspaceReady(page: Page): Promise<void> {
	await expect(page.getByRole("button", { name: /'s space/ })).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
}

function sidebarLists(page: Page): Locator {
	return page.getByRole("navigation", { name: "Lists" });
}

async function settings(page: Page): Promise<Locator> {
	const panel = page.getByTestId("notification-settings");
	await expect(panel).toBeVisible({ timeout: 15_000 });
	return panel;
}

async function userId(page: Page): Promise<string> {
	return await page.evaluate(async () => {
		const res = await fetch("/api/auth/get-session");
		return ((await res.json()) as { user: { id: string } }).user.id;
	});
}

// Saves a channel through the authenticated API in the page's session, so the
// interactive-ack test can stand up a disabled app-mode row without walking the
// whole credential form.
async function saveChannelApi(
	page: Page,
	body: Record<string, unknown>,
): Promise<void> {
	const res = await page.evaluate(async (b) => {
		const r = await fetch("/api/notifications/channel", {
			method: "POST",
			credentials: "include",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(b),
		});
		return { ok: r.ok, status: r.status, text: await r.text() };
	}, body);
	if (!res.ok) {
		throw new Error(
			`saveChannel ${body.kind} failed ${res.status}: ${res.text}`,
		);
	}
}

// Expand a collapsed row so its form mounts (shell doc 1).
async function expand(page: Page, kind: string): Promise<void> {
	if (!(await page.getByTestId(`channel-${kind}-form`).count())) {
		await page.getByTestId(`channel-${kind}-disclosure`).click();
	}
	await expect(page.getByTestId(`channel-${kind}-form`)).toBeVisible();
}

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
			`a11y[${surface}]`,
			JSON.stringify(
				serious.map((v) => ({ id: v.id, nodes: v.nodes.length })),
				null,
				2,
			),
		);
	expect(serious, `serious/critical a11y on ${surface}`).toEqual([]);
}

// The Actions header is `http, "Done", "<url>", method=POST, clear=true`; the
// capability token is the ack URL's last path segment. Reads the newest capture
// so a fresh test send is not shadowed by an earlier one on the same topic.
function ackTokenFromActions(actions: string | null): string | null {
	if (!actions) return null;
	const match = actions.match(/https?:\/\/[^\s",]+/);
	if (!match) return null;
	try {
		const segment = new URL(match[0]).pathname.split("/").pop();
		return segment || null;
	} catch {
		return null;
	}
}

async function readAckToken(topic: string): Promise<string> {
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		const res = await fetch(
			`${NTFY_CAPTURED}?topic=${encodeURIComponent(topic)}`,
		);
		const rows = (await res.json()) as { actions: string | null }[];
		for (let i = rows.length - 1; i >= 0; i--) {
			const token = ackTokenFromActions(rows[i].actions);
			if (token) return token;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`no ack token captured on topic ${topic}`);
}

// A Discord app's Ed25519 keypair; the public key is the last 32 bytes of the
// SPKI DER, exchanged as hex (mirrors integration/discord-interactions.test.ts).
function discordApp(): { publicKey: string; sign: (m: Buffer) => string } {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
	return {
		publicKey: der.subarray(der.length - 32).toString("hex"),
		sign: (message) => sign(null, message, privateKey).toString("hex"),
	};
}

// Signs the exact octets Discord signs, `timestamp + rawBody`, never a
// re-serialization.
async function postDiscordInteraction(
	app: ReturnType<typeof discordApp>,
	interaction: unknown,
): Promise<Response> {
	const raw = Buffer.from(JSON.stringify(interaction), "utf8");
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = app.sign(
		Buffer.concat([Buffer.from(timestamp, "utf8"), raw]),
	);
	return await fetch(DISCORD_INTERACTIONS, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-signature-ed25519": signature,
			"x-signature-timestamp": timestamp,
		},
		body: raw,
	});
}

function pool(): Pool {
	return new Pool({ connectionString: process.env.E2E_DATABASE_URL });
}

// --- Surface: rows collapse by default and expand to per-kind forms ---
test.describe("channel settings surface", () => {
	test.beforeEach(async ({ page }) => {
		await signUp(page, uniqueEmail("chan"));
		await waitWorkspaceReady(page);
		await settings(page);
	});

	test("rows collapse by default with a public-only summary, and expand", async ({
		page,
	}) => {
		// All five rows render; none is expanded, so no form is mounted.
		for (const kind of ["ntfy", "telegram", "discord", "slack", "email"]) {
			await expect(page.getByTestId(`channel-${kind}`)).toBeVisible();
			await expect(page.getByTestId(`channel-${kind}-form`)).toHaveCount(0);
		}
		// An unconfigured row summarises as "Not set up", never a field value.
		await expect(page.getByTestId("channel-telegram")).toContainText(
			"Not set up",
		);

		// Expanding ntfy mounts its own kind's fields (serverUrl/topic/token).
		await expand(page, "ntfy");
		await expect(page.getByTestId("channel-ntfy-serverUrl")).toBeVisible();
		await expect(page.getByTestId("channel-ntfy-topic")).toBeVisible();

		// Telegram's form is a different shape: a bot token and a chat id, proving
		// the form is derived per kind rather than shared.
		await expand(page, "telegram");
		await expect(page.getByTestId("channel-telegram-botToken")).toBeVisible();
		await expect(page.getByTestId("channel-telegram-chatId")).toBeVisible();

		// The public summary shows the topic, never the (masked) token.
		await page.getByTestId("channel-ntfy-serverUrl").fill(NTFY);
		await page.getByTestId("channel-ntfy-topic").fill("summary-topic");
		await page.getByTestId("channel-ntfy-token").fill("tok_secret_value_1");
		await page.getByTestId("channel-ntfy-save").click();
		await expect(page.getByTestId("channel-ntfy-toggle")).toHaveAttribute(
			"aria-checked",
			"true",
			{ timeout: 15_000 },
		);
		await page.reload();
		await waitWorkspaceReady(page);
		await settings(page);
		const ntfyRow = page.getByTestId("channel-ntfy");
		await expect(ntfyRow).toContainText("summary-topic");
		await expect(ntfyRow).not.toContainText("tok_secret_value_1");
	});

	test("masked fields render *** for a stored secret and blank for none", async ({
		page,
	}) => {
		// Save WITHOUT a token: the masked field has nothing stored.
		await expand(page, "ntfy");
		await page.getByTestId("channel-ntfy-serverUrl").fill(NTFY);
		await page.getByTestId("channel-ntfy-topic").fill("mask-none");
		await page.getByTestId("channel-ntfy-save").click();
		await expect(page.getByTestId("channel-ntfy-toggle")).toHaveAttribute(
			"aria-checked",
			"true",
			{ timeout: 15_000 },
		);
		await page.reload();
		await waitWorkspaceReady(page);
		await settings(page);
		await expand(page, "ntfy");
		// Blank, never "***": a field with no stored value must not claim one.
		await expect(page.getByTestId("channel-ntfy-token")).toHaveValue("");

		// Now store a token; on reload the masked field is "***", never cleartext.
		await page.getByTestId("channel-ntfy-token").fill("tok_secret_value_2");
		await page.getByTestId("channel-ntfy-save").click();
		await page.reload();
		await waitWorkspaceReady(page);
		await settings(page);
		await expand(page, "ntfy");
		await expect(page.getByTestId("channel-ntfy-token")).toHaveValue("***");
		expect(await page.content()).not.toContain("tok_secret_value_2");
	});

	test("Discord mode radiogroup carries an always-visible consequence line", async ({
		page,
	}) => {
		await expand(page, "discord");
		const modeNote = page.getByTestId("channel-discord-mode-note");
		// Webhook is the default; its consequence line is visible without any hover.
		await expect(page.getByRole("radio", { name: "Webhook" })).toBeChecked();
		await expect(modeNote).toBeVisible();
		await expect(modeNote).toContainText("can't carry buttons");

		// Selecting App swaps the consequence line to the app-mode copy. On this
		// deployment (public base URL present) App is enabled, so it shows the
		// copyable interactions URL to paste into the provider.
		await page.getByRole("radio", { name: "App", exact: true }).check();
		await expect(modeNote).toContainText("Acknowledge button");
		await expect(
			page.getByTestId("channel-discord-interactions-url"),
		).toBeVisible();
	});

	test("the email row is visible but unavailable when SMTP is absent", async ({
		page,
	}) => {
		// The default deployment carries no SMTP: the row stays in the list with a
		// reason rather than vanishing (shell doc 6), and is not expandable while
		// nothing is stored.
		const emailRow = page.getByTestId("channel-email");
		await expect(emailRow).toHaveAttribute("aria-disabled", "true");
		await expect(page.getByTestId("channel-email-unavailable")).toContainText(
			"Email delivery is not set up",
		);
		await expect(page.getByTestId("channel-email-disclosure")).toBeDisabled();
	});
});

// --- A stored email row survives SMTP going away and stays removable ---
test("a stored email channel stays expandable and removable after SMTP disappears", async ({
	page,
}) => {
	// Sign up on the default (SMTP-less) web app.
	const email = uniqueEmail("email-disappear");
	await signUp(page, email);
	await waitWorkspaceReady(page);
	const uid = await userId(page);

	// Seed an email channel directly, standing in for one saved while the server
	// still had SMTP. email's `address` is a PUBLIC field stored in cleartext (no
	// envelope), so a plain row is exactly what the save path would have written.
	// The deployment under test has no SMTP, so the row must render unavailable
	// while the user's own stored config stays inspectable and removable (shell
	// doc 6): unavailable is not the same as frozen.
	const db = pool();
	try {
		await db.query(
			`insert into notification_channel (id, user_id, kind, config, enabled)
			 values ($1, $2, 'email', $3::jsonb, true)`,
			[randomUUID(), uid, JSON.stringify({ address: email })],
		);
	} finally {
		await db.end();
	}

	// The row is present, marked unavailable, but not frozen.
	await page.reload();
	await waitWorkspaceReady(page);
	await settings(page);
	const emailRow = page.getByTestId("channel-email");
	await expect(emailRow).toHaveAttribute("aria-disabled", "true", {
		timeout: 15_000,
	});
	await expect(emailRow).toContainText(email);
	// The disclosure's own `disabled` is false (a stored row is not frozen), so a
	// real user can open it -- but the row's ancestor <section aria-disabled> makes
	// Playwright's actionability treat every control inside it as not-enabled. force
	// bypasses that check to exercise the click a real user makes; the React
	// handler is live either way.
	await page.getByTestId("channel-email-disclosure").click({ force: true });
	await expect(page.getByTestId("channel-email-form")).toBeVisible();
	await expect(page.getByTestId("channel-email-address")).toHaveValue(email);
	await page.getByTestId("channel-email-remove").click({ force: true });
	// Removed: the row falls back to unconfigured and its disclosure is now
	// genuinely disabled (frozen: unavailable with nothing stored).
	await expect(emailRow).toContainText("Not set up", { timeout: 15_000 });
	await expect(page.getByTestId("channel-email-disclosure")).toBeDisabled();
});

// --- Mail path: real SMTP bytes reach the loopback sink ---
test("email test-send delivers real SMTP bytes to the sink", async ({
	playwright,
}) => {
	const email = uniqueEmail("mail-wire");
	// Both guardedPost (requireSameOrigin) and Better Auth's own CSRF check refuse
	// a POST whose Origin is not trusted; localhost:5173 is in both allow-lists on
	// the SMTP server (requestOrigins and trustedAuthOrigins), so present it.
	const api = await playwright.request.newContext({
		extraHTTPHeaders: { Origin: "http://localhost:5173" },
	});
	let res = await api.post(`${MAIL_API}/api/auth/sign-up/email`, {
		data: { email, password: PASSWORD, name: "Mail Wire" },
	});
	expect(res.ok(), await res.text()).toBeTruthy();

	// Save & test send drives the shared SMTP transport synchronously.
	res = await api.post(`${MAIL_API}/api/notifications/channel/test`, {
		data: { kind: "email", enabled: true, config: { address: email } },
	});
	expect(res.ok(), await res.text()).toBeTruthy();
	expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
	await api.dispose();

	// Read the wire: the sink recorded the exact command lines and DATA bytes.
	// Sign-up on an SMTP deployment also sends a verification mail to this same
	// address, so the notification is matched by its own body, not the recipient.
	const NOTIFY_BODY = "Test notification from Ditero.";
	const captured = await (async () => {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const data = (await (
				await fetch(`${SMTP_CAPTURE}/_captured`)
			).json()) as {
				commands: string[];
				messages: string[];
			};
			if (data.messages.some((m) => m.includes(NOTIFY_BODY))) return data;
			if (Date.now() > deadline) return data;
			await new Promise((r) => setTimeout(r, 250));
		}
	})();

	// The envelope reached the sink addressed to this recipient...
	expect(
		captured.commands.some((c) => /^RCPT TO:/i.test(c) && c.includes(email)),
	).toBe(true);
	// ...and the notification's DATA carried the subject, body, To, and link ack.
	const message = captured.messages.find((m) => m.includes(NOTIFY_BODY));
	expect(message, "no notification DATA message on the wire").toBeTruthy();
	expect(message).toContain("Ditero test");
	expect(message).toContain(email);
	expect(message).toContain("Mark it done:");
});

// --- Test-send states + ack round trip, durable across a reload ---
test("test-send states, and an acked verify capability survives a reload", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("verify"));
	await waitWorkspaceReady(page);
	await settings(page);

	// State: untested. A stored-but-never-tested channel reports "Not tested"
	// (the status is a property of a saved row; an unconfigured row shows none).
	await expand(page, "ntfy");
	await page.getByTestId("channel-ntfy-serverUrl").fill(NTFY);
	await page.getByTestId("channel-ntfy-topic").fill("e2e-untested");
	await page.getByTestId("channel-ntfy-save").click();
	await expect(page.getByTestId("channel-ntfy")).toContainText("Not tested", {
		timeout: 15_000,
	});

	// State: failed. The stub answers 401 on this topic; the reason is one of the
	// closed category set, never a passthrough.
	await page.getByTestId("channel-ntfy-topic").fill("reject-me");
	await page.getByTestId("channel-ntfy-test").click();
	await expect(page.getByTestId("channel-ntfy-test-result")).toContainText(
		"Server rejected the request",
		{ timeout: 20_000 },
	);

	// State: sent (accepted, not yet acknowledged). A real topic + the verify
	// capability the test send mints.
	const topic = `e2e-verify-${Date.now()}`;
	await page.getByTestId("channel-ntfy-topic").fill(topic);
	await page.getByTestId("channel-ntfy-test").click();
	await expect(page.getByTestId("channel-ntfy-test-result")).toContainText(
		"Sent",
		{ timeout: 20_000 },
	);
	await expect(page.getByTestId("channel-ntfy")).toContainText(
		"not acknowledged",
	);

	// Redeem the verify capability the test message carried, through the
	// deployment's own ack link route (valid for any kind). This is what
	// "Verified" is reserved for -- an acknowledgement that actually came back.
	const token = await readAckToken(topic);
	const ack = await fetch(`${ACK_ROUTE}/${token}`, { method: "POST" });
	expect(ack.status).toBe(200);

	// The synced channel health flips the row to "Verified" without a reload...
	await expect(page.getByTestId("channel-ntfy")).toContainText("Verified", {
		timeout: 20_000,
	});
	await expect(page.getByTestId("channel-ntfy")).not.toContainText(
		"not acknowledged",
	);

	// ...and it SURVIVES a reload: ack_verified_at is a server column, not
	// client state, so the acknowledged claim is durable.
	await page.reload();
	await waitWorkspaceReady(page);
	await settings(page);
	await expect(page.getByTestId("channel-ntfy")).toContainText("Verified", {
		timeout: 20_000,
	});
});

// --- Interactive ack: a signed Discord interaction acks a live reminder ---
test("interactive ack: a signed Discord POST acks a live reminder and terminates a sibling", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const ctxA = await browser.newContext();
	const pageA = await ctxA.newPage();
	await signUp(pageA, uniqueEmail("iack"));
	await waitWorkspaceReady(pageA);
	const aId = await userId(pageA);

	const app = discordApp();
	const CHANNEL_ID = "100200300400500600";
	const topic = `e2e-iack-${Date.now()}`;

	// ntfy delivers the reminder and carries the ack token to the tap. The
	// discord app-mode row is DISABLED so nothing is sent to discord.com, but the
	// interactions listener still reads its (user-supplied) public key and channel
	// id to authorise the signed POST.
	await saveChannelApi(pageA, {
		kind: "ntfy",
		enabled: true,
		config: { serverUrl: NTFY, topic },
	});
	await saveChannelApi(pageA, {
		kind: "discord",
		enabled: false,
		config: {
			mode: "app",
			botToken: "bot-e2e-token-value",
			publicKey: app.publicKey,
			channelId: CHANNEL_ID,
		},
	});

	// A habits reminder just in the past, materialised by the real scheduler.
	await waitWorkspaceReady(pageA);
	await pageA.getByRole("combobox", { name: "Start from template" }).click();
	await pageA.getByRole("option", { name: "Habits", exact: true }).click();
	await pageA.getByTestId("new-list-submit").click();
	await sidebarLists(pageA)
		.getByRole("button", { name: "Habits", exact: true })
		.last()
		.click();
	await expect(pageA.getByTestId("list")).toBeVisible({ timeout: 15_000 });
	await pageA
		.locator("[data-kbd-nav]")
		.filter({ hasText: "Drink water" })
		.first()
		.click();
	const detail = pageA.getByRole("dialog");
	await expect(detail.getByLabel("Task title")).toBeVisible();
	const when = await pageA.evaluate(() => {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const at = new Date(Date.now() - 2 * 60_000);
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: zone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}).formatToParts(at);
		const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
		return {
			date: `${get("year")}-${get("month")}-${get("day")}`,
			time: `${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}`,
		};
	});
	await detail.getByLabel("Due date").fill(when.date);
	await detail.getByTestId("reminder-time").fill(when.time);
	await pageA.keyboard.press("Escape");
	await expect(pageA.getByRole("dialog")).toBeHidden({ timeout: 15_000 });

	// The scan materialises reminder_state, which syncs back as a live chip.
	const chip = pageA.getByTestId("reminder-chip").first();
	await expect(chip).toBeVisible({ timeout: 45_000 });

	// Read the ack token off the ntfy tap.
	const token = await readAckToken(topic);

	// Seed a sibling reminder for a second user on the same occurrence.
	const bId = await freshUserId(browser);
	const taskId = await seedSibling(aId, bId);

	// A correctly-signed Discord interaction carrying the token acks it.
	const res = await postDiscordInteraction(app, {
		id: "e2e-interaction",
		application_id: "e2e-app",
		type: 3,
		token: "e2e-interaction-token",
		channel_id: CHANNEL_ID,
		data: { custom_id: `c:${token}`, component_type: 2 },
		message: { id: "m1", content: "Reminder" },
		member: { user: { id: "909090909090909090" }, roles: [] },
	});
	expect(res.status).toBe(200);
	expect(((await res.json()) as { type: number }).type).toBe(7); // UPDATE_MESSAGE

	// The open Zero client sees the ack propagate to the chip.
	await expect(chip).toContainText("Acknowledged", { timeout: 20_000 });

	// The sibling on the same occurrence was terminated server-side.
	await expect
		.poll(() => siblingStatus(bId, taskId), { timeout: 15_000 })
		.toBe("acked");

	await ctxA.close();
});

// A throwaway second user, for the seeded sibling's recipient FK.
async function freshUserId(browser: Browser): Promise<string> {
	const ctx = await browser.newContext();
	try {
		const page = await ctx.newPage();
		await signUp(page, uniqueEmail("sibling"));
		return await userId(page);
	} finally {
		await ctx.close();
	}
}

// Copies A's fired reminder onto a second recipient at the same occurrence, so
// the ack has a sibling to terminate. Returns the task id both share.
async function seedSibling(aId: string, bId: string): Promise<string> {
	const db = pool();
	try {
		const { rows } = await db.query<{ task_id: string; occurrence_at: Date }>(
			`select task_id, occurrence_at from reminder_state
			 where recipient_user_id = $1 order by created_at desc limit 1`,
			[aId],
		);
		const rs = rows[0];
		if (!rs) throw new Error("no reminder_state for the primary user");
		await db.query(
			`insert into reminder_state
			   (id, task_id, occurrence_at, recipient_user_id, status, fire_count)
			 values ($1, $2, $3, $4, 'pending', 1)`,
			[randomUUID(), rs.task_id, rs.occurrence_at, bId],
		);
		return rs.task_id;
	} finally {
		await db.end();
	}
}

async function siblingStatus(
	bId: string,
	taskId: string,
): Promise<string | null> {
	const db = pool();
	try {
		const { rows } = await db.query<{ status: string }>(
			`select status from reminder_state
			 where recipient_user_id = $1 and task_id = $2 limit 1`,
			[bId, taskId],
		);
		return rows[0]?.status ?? null;
	} finally {
		await db.end();
	}
}

// --- Axe merge gate on the channel surfaces (shell doc 8) ---
test("a11y: no serious/critical violations on channel surfaces", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await signUp(page, uniqueEmail("axe-chan"));
	await waitWorkspaceReady(page);
	await settings(page);

	// Collapsed rows: labelled row groups + the unavailable email row's
	// aria-disabled + visible reason.
	await expectNoSeriousA11y(page, "channels (collapsed)");

	// Discord expanded: the mode radiogroup, its aria-describedby consequence
	// line, and the app-mode interactions URL.
	await expand(page, "discord");
	await page.getByRole("radio", { name: "App", exact: true }).check();
	await expect(
		page.getByTestId("channel-discord-interactions-url"),
	).toBeVisible();
	await expectNoSeriousA11y(page, "channels (discord app mode)");

	// A configured row with its per-row live region present.
	await expand(page, "ntfy");
	await page.getByTestId("channel-ntfy-serverUrl").fill(NTFY);
	await page.getByTestId("channel-ntfy-topic").fill("axe-topic");
	await page.getByTestId("channel-ntfy-save").click();
	await expect(page.getByTestId("channel-ntfy-toggle")).toHaveAttribute(
		"aria-checked",
		"true",
		{ timeout: 15_000 },
	);
	await expectNoSeriousA11y(page, "channels (configured)");
});
