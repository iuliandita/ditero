import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { Pool } from "pg";

// M1b sharing/people e2e. Two browser contexts = two clients; assertions are
// real cross-client Zero sync (invite/accept, assign, comment, kid) plus an
// outsider isolation regression and the axe merge gate on the new surfaces.
//
// Accept handshake: the invitee redeems through the real client `/accept?token=`
// page. Scenario 1 drives the logged-out funnel (sign up on the page, then it
// auto-accepts); scenario 3 drives the logged-in join. The web app and the auth
// server run on different ports in e2e, so we navigate to the token on the web
// origin (baseURL) rather than the raw link host (BETTER_AUTH_URL:3000).

const SHARED_WORKSPACE_ID = "w_shared_e2e";
const PASSWORD = "pw-123456";

let emailSeq = 0;
function uniqueEmail(prefix: string): string {
	emailSeq += 1;
	return `${prefix}-${Date.now()}-${emailSeq}@t.dev`;
}
function nameOf(email: string): string {
	return email.split("@")[0];
}

async function signUp(page: Page, email: string): Promise<string> {
	await page.goto("/");
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill(PASSWORD);
	await page.getByTestId("signup").click();
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 15000 });
	const session = await page.evaluate(async () => {
		const response = await fetch("/api/auth/get-session");
		return (await response.json()) as { user: { id: string } };
	});
	return session.user.id;
}

// Add `userId` to the seeded shared workspace at `role`. Owner/admin see pending
// invites (queries.invites gate); member+ can invite. Direct upstream write ->
// zero-cache replicates it to any already-open client (same path joinShared uses
// across the domain spec).
async function joinShared(
	userId: string,
	role: "owner" | "admin" | "member" | "viewer" = "member",
): Promise<void> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await pool.query(
			`insert into membership (id, user_id, workspace_id, role)
			 values ($1, $2, $3, $4)`,
			[crypto.randomUUID(), userId, SHARED_WORKSPACE_ID, role],
		);
	} finally {
		await pool.end();
	}
}

async function openSharedDesktop(page: Page): Promise<void> {
	await page.getByTestId("open-shared").click();
	await expect(page.getByTestId("new-task")).toBeVisible({ timeout: 15000 });
}

async function addTask(page: Page, title: string): Promise<void> {
	await page.getByTestId("new-task").fill(title);
	await page.getByTestId("new-task-submit").click();
	await expect(
		page.getByTestId("list").getByText(title, { exact: true }),
	).toBeVisible({ timeout: 15000 });
}

async function openTaskDetail(page: Page, title: string): Promise<Page> {
	await page
		.getByTestId("list")
		.getByRole("button", { name: title, exact: true })
		.click();
	await expect(page.getByRole("dialog")).toBeVisible();
	return page;
}

// The seeded shared workspace + list persist across the whole run (global-setup
// seeds once), so its list accumulates tasks from earlier tests. Scope the chip
// lookup to a single task's row (chips render inside the row's title button) to
// keep assertions unambiguous under accumulation.
function taskRowChips(page: Page, title: string) {
	return page
		.getByTestId("list")
		.locator("button", { hasText: title })
		.getByTestId("assignee-chips");
}

// Radix Sheet is not reliably dismissed by Escape once a nested Dialog stole and
// returned focus; use its explicit Close control and wait for teardown.
async function closeMembersPanel(page: Page): Promise<void> {
	await page
		.getByTestId("members-panel")
		.getByRole("button", { name: "Close" })
		.click();
	await expect(page.getByTestId("members-panel")).toBeHidden();
}

function tokenFrom(link: string): string {
	const token = new URL(link).searchParams.get("token");
	if (!token) throw new Error(`no token in invite link: ${link}`);
	return token;
}

// Redeem an invite by driving the real client accept page. `join` uses the
// already-authenticated context's session; `signup` creates the account on the
// page (prefilled email is set explicitly to be safe). Either way the page
// auto-accepts and redirects to "/", so we wait for the app shell (new-list).
async function redeemViaAcceptPage(
	page: Page,
	token: string,
	opts: { mode: "join" } | { mode: "signup"; email: string; password: string },
): Promise<void> {
	await page.goto(`/accept?token=${token}`);
	await expect(page.getByTestId("accept-page")).toBeVisible({ timeout: 15000 });
	await expect(page.getByTestId("accept-join-line")).toBeVisible();
	if (opts.mode === "join") {
		await page.getByTestId("accept-join").click();
	} else {
		await page.getByTestId("accept-email").fill(opts.email);
		await page.getByTestId("accept-password").fill(opts.password);
		await page.getByTestId("accept-submit").click();
	}
	await expect(page.getByTestId("new-list")).toBeVisible({ timeout: 20000 });
}

// Gate per design 2.14: zero serious/critical violations. Moderate/minor logged
// only. Freeze animations so axe samples the settled frame (matches domain spec).
async function expectNoSeriousA11y(page: Page, surface: string): Promise<void> {
	await page.addStyleTag({
		content:
			"*,*::before,*::after{animation:none!important;transition:none!important}",
	});
	const { violations } = await new AxeBuilder({ page }).analyze();
	const serious = violations.filter(
		(v) => v.impact === "serious" || v.impact === "critical",
	);
	const minor = violations.filter(
		(v) => v.impact !== "serious" && v.impact !== "critical",
	);
	if (minor.length > 0)
		console.log(
			`a11y[${surface}] moderate/minor:`,
			minor.map((v) => v.id).join(", "),
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

// --- Scenario 1: email invite -> accept -> member on both, pending drops ---
test("invite: email invite accepted -> member syncs to both, pending drops", async ({
	browser,
}) => {
	test.setTimeout(90000);
	const a = await browser.newContext();
	const b = await browser.newContext();
	const pa = await a.newPage();
	const pb = await b.newPage();

	const ownerEmail = uniqueEmail("s1-owner");
	const inviteeEmail = uniqueEmail("s1-invitee");
	const inviteeName = nameOf(inviteeEmail);

	const ownerId = await signUp(pa, ownerEmail);
	await joinShared(ownerId, "owner");
	// pb stays logged out: it will sign up ON the accept page (the real new-invitee
	// funnel). Open registration in e2e permits the accept-page signup.

	await openSharedDesktop(pa);
	await pa.getByTestId("open-members").click();
	await expect(pa.getByTestId("members-panel")).toBeVisible();

	// Owner mints an email invite; the link (token) is shown once.
	await pa.getByTestId("invite-open").click();
	await expect(pa.getByTestId("invite-dialog")).toBeVisible();
	await pa.getByTestId("invite-email").fill(inviteeEmail);
	await pa.getByTestId("invite-submit").click();
	await expect(pa.getByTestId("invite-link")).toBeVisible();
	const token = tokenFrom(await pa.getByTestId("invite-link").inputValue());
	await pa.keyboard.press("Escape"); // close dialog, back to members panel

	// Owner sees the pending invite entry (owner role syncs it).
	const panel = pa.getByTestId("members-panel");
	await expect(panel.getByText(inviteeEmail)).toBeVisible({ timeout: 15000 });

	// Invitee redeems through the real accept page: signs up, page auto-accepts.
	await redeemViaAcceptPage(pb, token, {
		mode: "signup",
		email: inviteeEmail,
		password: PASSWORD,
	});

	// Member on both clients: invitee's client gains the shared workspace + list.
	await openSharedDesktop(pb);
	await expect(pb.getByText("Shared list", { exact: true })).toBeVisible({
		timeout: 15000,
	});
	// Owner's panel: the invitee now shows as a member (co-member membership synced
	// live). The pending entry drops -- an email invite is single-use (maxUses=1),
	// so acceptInvite flips it to 'accepted' and it leaves the pending-only synced
	// query.
	await expect(panel.getByText(inviteeName, { exact: true })).toBeVisible({
		timeout: 15000,
	});
	await expect(panel.getByText(inviteeEmail)).toHaveCount(0);

	await a.close();
	await b.close();
});

// --- Scenario 2: assign a member -> chip appears on the member's client ---
test("assign: owner assigns member -> assignee chip syncs to the member", async ({
	browser,
}) => {
	test.setTimeout(90000);
	const a = await browser.newContext();
	const b = await browser.newContext();
	const pa = await a.newPage();
	const pb = await b.newPage();

	const ownerEmail = uniqueEmail("s2-owner");
	const memberEmail = uniqueEmail("s2-member");
	const memberName = nameOf(memberEmail);

	const ownerId = await signUp(pa, ownerEmail);
	await joinShared(ownerId, "owner");
	const memberId = await signUp(pb, memberEmail);
	await joinShared(memberId, "member");

	await openSharedDesktop(pa);
	await openSharedDesktop(pb);
	await addTask(pa, "Assign me");
	await expect(
		pb.getByTestId("list").getByText("Assign me", { exact: true }),
	).toBeVisible({ timeout: 15000 });

	await openTaskDetail(pa, "Assign me");
	await pa.getByTestId("assignee-open").click();
	await expect(pa.getByTestId("assignee-picker")).toBeVisible();
	await pa
		.getByTestId("assignee-picker")
		.locator('[data-testid="assignee-option"]')
		.filter({ hasText: memberName })
		.click();
	// Owner side reflects the assignment immediately.
	await expect(pa.getByTestId("assignee-open")).toContainText("Assignees (1)");

	// Member's client: the row's assignee chip appears within the sync window.
	const chip = taskRowChips(pb, "Assign me");
	await expect(chip).toBeVisible({ timeout: 8000 });
	await expect(chip).toHaveAttribute(
		"aria-label",
		new RegExp(`Assignees: .*${memberName}`),
	);

	await a.close();
	await b.close();
});

// --- Scenario 3: invite-on-assign (email lookup) -> accept -> resolves to chip ---
test("invite-on-assign: pick a non-member by email -> accept resolves the assignment", async ({
	browser,
}) => {
	test.setTimeout(90000);
	const a = await browser.newContext();
	const c = await browser.newContext();
	const pa = await a.newPage();
	const pc = await c.newPage();

	const ownerEmail = uniqueEmail("s3-owner");
	const outsiderEmail = uniqueEmail("s3-outsider");
	const outsiderName = nameOf(outsiderEmail);

	const ownerId = await signUp(pa, ownerEmail);
	await joinShared(ownerId, "owner");
	await signUp(pc, outsiderEmail); // exists as a user, not in the workspace

	await openSharedDesktop(pa);
	await addTask(pa, "Invite assign");
	await openTaskDetail(pa, "Invite assign");
	await pa.getByTestId("assignee-open").click();
	await expect(pa.getByTestId("assignee-picker")).toBeVisible();

	// Look the outsider up by exact email; selecting raises the invite confirm.
	await pa.getByTestId("assignee-email").fill(outsiderEmail);
	await pa.getByTestId("assignee-email").press("Enter");
	await pa
		.getByTestId("assignee-picker")
		.locator('[data-testid="assignee-option"]')
		.filter({ hasText: outsiderName })
		.click();
	await expect(pa.getByTestId("assignee-invite-confirm")).toBeVisible();
	await pa.getByTestId("assignee-invite-confirm-submit").click();
	await expect(pa.getByTestId("assignee-invite-link")).toBeVisible();
	const token = tokenFrom(
		await pa.getByTestId("assignee-invite-link").inputValue(),
	);

	// No assignment yet -- it is pending on acceptance. The outsider is already
	// signed in, so the accept page shows Join; clicking it redeems the token.
	await redeemViaAcceptPage(pc, token, { mode: "join" });

	// The attach resolves: membership + task_assignee in one tx -> chip on owner.
	// Detail sheet overlays the row; close it so the row chip is observable.
	await pa.keyboard.press("Escape");
	const chip = taskRowChips(pa, "Invite assign");
	await expect(chip).toBeVisible({ timeout: 15000 });
	await expect(chip).toHaveAttribute(
		"aria-label",
		new RegExp(`Assignees: .*${outsiderName}`),
	);
	// Newly joined user reaches the shared workspace.
	await openSharedDesktop(pc);
	await expect(pc.getByText("Shared list", { exact: true })).toBeVisible({
		timeout: 15000,
	});

	await a.close();
	await c.close();
});

// --- Scenario 4: comment with an @mention -> renders on the other client ---
test("comment: @mention comment on A renders on B within the sync window", async ({
	browser,
}) => {
	test.setTimeout(90000);
	const a = await browser.newContext();
	const b = await browser.newContext();
	const pa = await a.newPage();
	const pb = await b.newPage();

	const ownerEmail = uniqueEmail("s4-owner");
	const memberEmail = uniqueEmail("s4-member");
	const memberName = nameOf(memberEmail);

	const ownerId = await signUp(pa, ownerEmail);
	await joinShared(ownerId, "owner");
	const memberId = await signUp(pb, memberEmail);
	await joinShared(memberId, "member");

	await openSharedDesktop(pa);
	await openSharedDesktop(pb);
	await addTask(pa, "Discuss");
	await expect(
		pb.getByTestId("list").getByText("Discuss", { exact: true }),
	).toBeVisible({ timeout: 15000 });

	// Both open the same task's detail so both comment threads are subscribed.
	await openTaskDetail(pa, "Discuss");
	await openTaskDetail(pb, "Discuss");

	// Compose with the @mention picker: type "@<prefix>", pick the member.
	const input = pa.getByTestId("comment-input");
	await input.click();
	await input.pressSequentially(`Please review @${memberName.slice(0, 6)}`);
	await expect(pa.getByTestId("mention-suggest")).toBeVisible();
	await pa
		.getByTestId("mention-suggest")
		.locator('[data-testid="mention-suggest-option"]')
		.filter({ hasText: memberName })
		.click();
	await pa.getByTestId("comment-submit").click();

	const expected = `Please review @${memberName}`;
	// Author sees their comment; B receives it (mention text intact) via sync.
	await expect(
		pa.getByTestId("comment-item").filter({ hasText: expected }),
	).toBeVisible({ timeout: 15000 });
	await expect(
		pb.getByTestId("comment-item").filter({ hasText: expected }),
	).toBeVisible({ timeout: 15000 });

	await a.close();
	await b.close();
});

// --- Scenario 5: kid managed account -> restricted shell, assigned task, no admin ---
test("kid: guardian adds a managed account -> restricted shell shows the assigned task", async ({
	browser,
}) => {
	test.setTimeout(90000);
	const guardianCtx = await browser.newContext();
	const kidCtx = await browser.newContext();
	const pg = await guardianCtx.newPage();
	const pk = await kidCtx.newPage();

	const guardianEmail = uniqueEmail("s5-guardian");
	const kidPassword = "kid-pw-123456";
	const kidName = "Kiddo";

	const guardianId = await signUp(pg, guardianEmail);
	await joinShared(guardianId, "owner");

	await openSharedDesktop(pg);
	await pg.getByTestId("open-members").click();
	await expect(pg.getByTestId("members-panel")).toBeVisible();

	// Provision the managed account; the handle is shown once.
	await pg.getByTestId("add-kid-open").click();
	await expect(pg.getByTestId("add-kid-dialog")).toBeVisible();
	await pg.getByTestId("add-kid-name").fill(kidName);
	await pg.getByTestId("add-kid-password").fill(kidPassword);
	await pg.getByTestId("add-kid-submit").click();
	await expect(pg.getByTestId("add-kid-handle")).toBeVisible();
	const kidHandle = await pg.getByTestId("add-kid-handle").inputValue();
	expect(kidHandle).toMatch(/@managed\.invalid$/);
	await pg.keyboard.press("Escape"); // close the add-kid dialog
	await expect(pg.getByTestId("add-kid-dialog")).toBeHidden();
	await closeMembersPanel(pg);

	// Assign a shared task to the kid (now a member of the shared workspace).
	await addTask(pg, "Walk the dog");
	await openTaskDetail(pg, "Walk the dog");
	await pg.getByTestId("assignee-open").click();
	await expect(pg.getByTestId("assignee-picker")).toBeVisible();
	await pg
		.getByTestId("assignee-picker")
		.locator('[data-testid="assignee-option"]')
		.filter({ hasText: kidName })
		.click();
	await expect(pg.getByTestId("assignee-open")).toContainText("Assignees (1)");

	// Kid signs in with the handle + guardian-set password -> restricted shell.
	await pk.goto("/");
	await pk.getByTestId("email").fill(kidHandle);
	await pk.getByTestId("password").fill(kidPassword);
	await pk.getByTestId("signin").click();
	await expect(pk.getByTestId("restricted-shell")).toBeVisible({
		timeout: 15000,
	});

	// The assigned task shows in the kid's cross-workspace "assigned to me" list.
	await expect(
		pk.getByTestId("restricted-task").filter({ hasText: "Walk the dog" }),
	).toBeVisible({ timeout: 15000 });

	// No management affordances leak into the restricted shell.
	await expect(pk.getByTestId("open-members")).toHaveCount(0);
	await expect(pk.getByTestId("invite-open")).toHaveCount(0);
	await expect(pk.getByTestId("new-list")).toHaveCount(0);
	await expect(pk.getByTestId("new-task")).toHaveCount(0);
	await expect(pk.getByTestId("add-kid-open")).toHaveCount(0);

	await guardianCtx.close();
	await kidCtx.close();
});

// --- Scenario 6: isolation -- an outsider never sees the shared people surfaces ---
test("isolation: an outsider sees no shared invites, assignees, comments, or managed rows", async ({
	browser,
}) => {
	test.setTimeout(90000);
	const a = await browser.newContext();
	const b = await browser.newContext();
	const o = await browser.newContext();
	const pa = await a.newPage();
	const pb = await b.newPage();
	const po = await o.newPage();

	const ownerEmail = uniqueEmail("s6-owner");
	const memberEmail = uniqueEmail("s6-member");
	const outsiderEmail = uniqueEmail("s6-outsider");
	const memberName = nameOf(memberEmail);
	const pendingInviteEmail = uniqueEmail("s6-pending");
	const kidName = "IsoKid";

	const ownerId = await signUp(pa, ownerEmail);
	await joinShared(ownerId, "owner");
	const memberId = await signUp(pb, memberEmail);
	await joinShared(memberId, "member");
	await signUp(po, outsiderEmail); // fresh user; never joins the shared workspace

	// Owner builds the full people surface inside the shared workspace.
	await openSharedDesktop(pa);
	const secretTask = "SharedSecretTask";
	await addTask(pa, secretTask);
	await openTaskDetail(pa, secretTask);
	// assignee
	await pa.getByTestId("assignee-open").click();
	await expect(pa.getByTestId("assignee-picker")).toBeVisible();
	await pa
		.getByTestId("assignee-picker")
		.locator('[data-testid="assignee-option"]')
		.filter({ hasText: memberName })
		.click();
	await pa.keyboard.press("Escape"); // close picker
	// comment
	const secretComment = "SharedSecretComment";
	await pa.getByTestId("comment-input").click();
	await pa.getByTestId("comment-input").fill(secretComment);
	await pa.getByTestId("comment-submit").click();
	await expect(
		pa.getByTestId("comment-item").filter({ hasText: secretComment }),
	).toBeVisible({ timeout: 15000 });
	await pa.keyboard.press("Escape"); // close detail
	// pending invite + kid via members panel
	await pa.getByTestId("open-members").click();
	await expect(pa.getByTestId("members-panel")).toBeVisible();
	await pa.getByTestId("invite-open").click();
	await pa.getByTestId("invite-email").fill(pendingInviteEmail);
	await pa.getByTestId("invite-submit").click();
	await expect(pa.getByTestId("invite-link")).toBeVisible();
	await pa.keyboard.press("Escape");
	await pa.getByTestId("add-kid-open").click();
	await pa.getByTestId("add-kid-name").fill(kidName);
	await pa.getByTestId("add-kid-password").fill("iso-kid-123456");
	await pa.getByTestId("add-kid-submit").click();
	await expect(pa.getByTestId("add-kid-handle")).toBeVisible();

	// Member (legitimate) receives the shared task -> proves sync is live and
	// settled, so the outsider's absence below is a real negative, not lag.
	await openSharedDesktop(pb);
	await expect(
		pb.getByTestId("list").getByText(secretTask, { exact: true }),
	).toBeVisible({ timeout: 15000 });

	// Outsider: fully loaded personal app, actively syncing. It must expose none
	// of the shared workspace or its people rows.
	await expect(po.getByTestId("new-list")).toBeVisible({ timeout: 15000 });
	// Clicking Open shared cannot surface a workspace the outsider has no
	// membership in.
	await po.getByTestId("open-shared").click();
	await po.waitForTimeout(1000);
	for (const needle of [
		"Shared list",
		secretTask,
		secretComment,
		pendingInviteEmail,
		kidName,
		memberName,
	]) {
		await expect(po.getByText(needle)).toHaveCount(0);
	}
	// The outsider's own members panel shows only itself: no pending, no kid.
	await po.getByTestId("open-members").click();
	await expect(po.getByTestId("members-panel")).toBeVisible();
	await expect(po.getByTestId("invite-revoke")).toHaveCount(0);
	// The outsider's own membership row is the only member (the "(you)" marker only
	// renders on the current user's row); scope to the members list so the panel's
	// "<name>'s space" description does not also match the name.
	await expect(
		po.getByTestId("members-panel").locator("ul").getByText("(you)"),
	).toBeVisible();
	await expect(
		po
			.getByTestId("members-panel")
			.locator("ul")
			.getByText(nameOf(outsiderEmail)),
	).toBeVisible();

	await a.close();
	await b.close();
	await o.close();
});

// --- Scenario 7: role change then removal (plan 004) ---
test("membership: owner changes a member's role, then removes them", async ({
	browser,
}) => {
	test.setTimeout(90000);
	const a = await browser.newContext();
	const b = await browser.newContext();
	const pa = await a.newPage();
	const pb = await b.newPage();
	const consoleErrors: string[] = [];
	pb.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});

	const ownerEmail = uniqueEmail("s7-owner");
	const memberEmail = uniqueEmail("s7-member");
	const memberName = nameOf(memberEmail);

	const ownerId = await signUp(pa, ownerEmail);
	await joinShared(ownerId, "owner");
	const memberId = await signUp(pb, memberEmail);
	await joinShared(memberId, "member");

	await openSharedDesktop(pa);
	await pa.getByTestId("open-members").click();
	await expect(pa.getByTestId("members-panel")).toBeVisible();

	// The member's own client stays open (unattended) through the whole flow,
	// so a removal that breaks a synced query for OTHER members would surface
	// here as a console error rather than passing silently.
	await openSharedDesktop(pb);

	const panel = pa.getByTestId("members-panel");
	const memberRow = panel
		.getByTestId("member-row")
		.filter({ hasText: memberName });
	await expect(memberRow).toBeVisible({ timeout: 15000 });
	await expect(memberRow.getByText("Member", { exact: true })).toBeVisible();

	// Change role: kebab -> "Change role" submenu -> "Viewer".
	await memberRow.getByTestId("row-actions").click();
	await memberRow
		.page()
		.locator('[data-slot="dropdown-menu-sub-trigger"]')
		.click();
	await memberRow.page().getByTestId("row-action-role:viewer").click();
	await expect(memberRow.getByText("Viewer", { exact: true })).toBeVisible({
		timeout: 15000,
	});
	// Wait for the first menu's close (unmount) to fully settle before reopening
	// it -- otherwise the second kebab click can land while Radix's dismiss
	// animation is still in flight and miss the panel entirely.
	await expect(
		memberRow.page().locator('[data-slot="dropdown-menu-content"]'),
	).toHaveCount(0);

	// Remove: kebab -> "Remove from workspace" -> confirm names the blast radius
	// -> accept. Present-then-absent on the SAME locator guards against a
	// vacuous pass from an aria-hidden-gated query.
	await memberRow.getByTestId("row-actions").click();
	await expect(memberRow.page().getByTestId("row-action-remove")).toBeVisible();
	await memberRow.page().getByTestId("row-action-remove").click();
	const confirmDialog = pa.getByTestId("confirm-dialog");
	await expect(confirmDialog).toBeVisible();
	await expect(confirmDialog).toContainText(memberName);
	await pa.getByTestId("confirm-accept").click();
	await expect(confirmDialog).toBeHidden();
	await expect(memberRow).toHaveCount(0, { timeout: 15000 });

	expect(consoleErrors).toEqual([]);

	await a.close();
	await b.close();
});

// --- Step 2: axe merge gate on the four sharing surfaces ---
test("a11y: no serious/critical violations on the sharing surfaces", async ({
	browser,
}) => {
	test.setTimeout(120000);
	const guardianCtx = await browser.newContext();
	const kidCtx = await browser.newContext();
	const pg = await guardianCtx.newPage();
	const pk = await kidCtx.newPage();

	const guardianEmail = uniqueEmail("axe-guardian");
	const kidPassword = "axe-kid-123456";
	const kidName = "AxeKid";

	const guardianId = await signUp(pg, guardianEmail);
	await joinShared(guardianId, "owner");
	await openSharedDesktop(pg);

	// Members panel.
	await pg.getByTestId("open-members").click();
	await expect(pg.getByTestId("members-panel")).toBeVisible();
	await expectNoSeriousA11y(pg, "members panel");

	// Invite dialog.
	await pg.getByTestId("invite-open").click();
	await expect(pg.getByTestId("invite-dialog")).toBeVisible();
	await expectNoSeriousA11y(pg, "invite dialog");
	await pg.keyboard.press("Escape");

	// Provision a kid so we can assign a task and later exercise the kid shell.
	await pg.getByTestId("add-kid-open").click();
	await expect(pg.getByTestId("add-kid-dialog")).toBeVisible();
	await pg.getByTestId("add-kid-name").fill(kidName);
	await pg.getByTestId("add-kid-password").fill(kidPassword);
	await pg.getByTestId("add-kid-submit").click();
	await expect(pg.getByTestId("add-kid-handle")).toBeVisible();
	const kidHandle = await pg.getByTestId("add-kid-handle").inputValue();
	await pg.keyboard.press("Escape");
	await expect(pg.getByTestId("add-kid-dialog")).toBeHidden();
	await closeMembersPanel(pg);

	// Task detail carrying an assignee + a comment.
	await addTask(pg, "Axe task");
	await openTaskDetail(pg, "Axe task");
	await pg.getByTestId("assignee-open").click();
	await expect(pg.getByTestId("assignee-picker")).toBeVisible();
	await pg
		.getByTestId("assignee-picker")
		.locator('[data-testid="assignee-option"]')
		.filter({ hasText: kidName })
		.click();
	await pg.keyboard.press("Escape"); // close picker, keep detail open
	await pg.getByTestId("comment-input").click();
	await pg.getByTestId("comment-input").fill("A comment for axe");
	await pg.getByTestId("comment-submit").click();
	await expect(pg.getByTestId("comment-item")).toBeVisible();
	await expectNoSeriousA11y(pg, "task detail (assignees + comments)");

	// Restricted (kid) shell.
	await pk.goto("/");
	await pk.getByTestId("email").fill(kidHandle);
	await pk.getByTestId("password").fill(kidPassword);
	await pk.getByTestId("signin").click();
	await expect(pk.getByTestId("restricted-shell")).toBeVisible({
		timeout: 15000,
	});
	await expect(
		pk.getByTestId("restricted-task").filter({ hasText: "Axe task" }),
	).toBeVisible({ timeout: 15000 });
	await expectNoSeriousA11y(pk, "restricted shell");

	await guardianCtx.close();
	await kidCtx.close();
});
