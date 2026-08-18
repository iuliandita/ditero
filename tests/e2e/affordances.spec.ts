import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { Pool } from "pg";
import type { Locale } from "../../src/domain/locale.ts";
import { m } from "../../src/paraglide/messages.js";

// M-ui row-affordances e2e. One RowAction[] descriptor renders three ways
// (kebab, right-click, keyboard), and every destructive action now runs through
// the in-app AlertDialog behind useConfirm -- never window.confirm, so
// page.on("dialog") is inert here by design.
//
// The hidden/disabled split is the milestone's core rule and is covered twice,
// deliberately not conflated: no permission means the item is ABSENT from the
// DOM (the Viewer scenario), while permission held with state blocking means
// present + aria-disabled + a visible reason (the non-empty folder).
//
// Conventions (signUp/uniqueEmail/testid locators/pg seeding/frozen-frame axe/
// locale switching) mirror dashboards.spec + sharing.spec + locale.spec.
test.describe.configure({ retries: 2, timeout: 90_000 });

const SYSTEM_USER_ID = "u_system_e2e";
const PASSWORD = "pw-123456";
const SIGNUP_TIMEOUT = 30_000;

let emailSeq = 0;
function uniqueEmail(prefix: string): string {
	emailSeq += 1;
	return `${prefix}-${Date.now()}-${emailSeq}@t.dev`;
}
// Names are asserted with exact locators, and the seeded shared fixtures persist
// across the whole run, so every name a test creates has to be unique to it.
function uniqueName(prefix: string): string {
	emailSeq += 1;
	return `${prefix} ${Date.now()}-${emailSeq}`;
}

async function signUp(page: Page, email: string): Promise<string> {
	await page.goto("/");
	await page.getByTestId("email").fill(email);
	await page.getByTestId("password").fill(PASSWORD);
	await page.getByTestId("signup").click();
	await expect(page.getByTestId("workspace")).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
	const session = await page.evaluate(async () => {
		const response = await fetch("/api/auth/get-session");
		return (await response.json()) as { user: { id: string } };
	});
	return session.user.id;
}

// The personal workspace name is minted server-side at signup (auth/bootstrap.ts
// builds "<name>'s space" in English), so this landmark is locale-independent.
async function waitWorkspaceReady(page: Page): Promise<void> {
	await expect(page.getByRole("button", { name: /'s space/ })).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
}

// Clicking the workspace button clears openListId/openViewId, which is the only
// way back to the lists index -- where LabelManager and TemplateManager mount on
// desktop (Workspace.tsx isDesktop block).
async function goToListsIndex(page: Page): Promise<void> {
	await page.getByRole("button", { name: /'s space/ }).click();
	await expect(page.getByTestId("label-manager")).toBeVisible({
		timeout: 15000,
	});
}

// Attribute selector, NOT getByRole: a Radix modal surface (every row menu and
// every confirm dialog here) mounts its content in a body portal and calls
// hideOthers(), which sets aria-hidden="true" on the portal's siblings -- i.e.
// on the whole app root. Playwright's role engine skips anything hidden for
// aria (queryRole -> isElementHiddenForAria), so while a menu is open a
// getByRole locator for ANYTHING outside it stops resolving: it reports
// "element(s) not found", and a toHaveCount(0) against it passes vacuously.
// Every locator that has to survive an open menu is therefore attribute-based.
// The other specs may use getByRole for this nav because none of them queries
// outside an open modal surface.
function sidebarLists(page: Page, locale: Locale = "en"): Locator {
	return page.locator(
		`nav[aria-label="${m.sidebar_lists_nav_label({}, { locale })}"]`,
	);
}

// The kebab's accessible name IS its aria-label (row-actions.tsx:120), so the
// attribute match is exact and equivalent to the role lookup it replaces.
function kebabIn(scope: Locator, name: string, locale: Locale = "en"): Locator {
	return scope.locator(
		`button[aria-label="${m.row_actions_for({ name }, { locale })}"]`,
	);
}

// The open list's header carries a second RowActions with the SAME aria-label
// (ListView.tsx:301), so every kebab lookup here is scoped to the sidebar.
function listRowKebab(
	page: Page,
	name: string,
	locale: Locale = "en",
): Locator {
	return kebabIn(sidebarLists(page, locale), name, locale);
}

function listRow(page: Page, name: string, locale: Locale = "en"): Locator {
	return sidebarLists(page, locale)
		.getByRole("listitem")
		.filter({
			has: page.getByRole("button", { name, exact: true }),
		});
}

async function createListDesktop(
	page: Page,
	name: string,
	locale: Locale = "en",
): Promise<void> {
	await waitWorkspaceReady(page);
	await page.getByTestId("new-list").fill(name);
	await page.getByTestId("new-list-submit").click();
	await expect(
		sidebarLists(page, locale)
			.getByRole("button", { name, exact: true })
			.first(),
	).toBeVisible({ timeout: 15000 });
}

async function openListDesktop(page: Page, name: string): Promise<void> {
	await sidebarLists(page).getByRole("button", { name, exact: true }).click();
	await expect(page.getByTestId("list")).toBeVisible({ timeout: 15000 });
}

async function addTask(page: Page, title: string): Promise<void> {
	await page.getByTestId("new-task").fill(title);
	await page.getByTestId("new-task-submit").click();
	await expect(
		page.getByTestId("list").getByText(title, { exact: true }),
	).toBeVisible({ timeout: 15000 });
}

// Open a row menu and wait for it to be usable. aria-expanded is the trigger's
// own state, so this cannot pass off a stale menu from a previous step.
async function openRowMenu(trigger: Locator): Promise<void> {
	await trigger.click();
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	await expect(trigger.page().getByRole("menu").first()).toBeVisible();
}

async function closeRowMenu(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await expect(page.getByRole("menu")).toHaveCount(0);
}

async function createFolder(page: Page, name: string): Promise<void> {
	await page.getByTestId("new-folder").click();
	await page.getByTestId("folder-name-input").fill(name);
	await page.getByTestId("folder-name-save").click();
	await expect(page.getByTestId("folder-name-input")).toBeHidden({
		timeout: 15000,
	});
	// Wait for the heading to sync before any caller drives the move submenu,
	// which only lists folders the client already has.
	await expect(sidebarLists(page).getByText(name, { exact: true })).toBeVisible(
		{ timeout: 15000 },
	);
}

// Drive the "Move to folder >" submenu. Its trigger is a DropdownMenuSubTrigger
// (row-actions.tsx), which carries no testid -- only the submenu's leaves do --
// so the trigger is located by its translated label and the destination by the
// folder's own name, both exact.
async function moveListToFolder(
	page: Page,
	listName: string,
	destination: string | null,
): Promise<void> {
	await openRowMenu(listRowKebab(page, listName));
	await page
		.getByRole("menuitem", {
			name: m.action_move_to_folder({}, { locale: "en" }),
			exact: true,
		})
		.click();
	if (destination === null) {
		await page.getByTestId("row-action-move-none").click();
	} else {
		await page
			.getByRole("menuitem", { name: destination, exact: true })
			.click();
	}
	await expect(page.getByRole("menu")).toHaveCount(0);
}

// Poll upstream Postgres until `read` returns `expected`: an expect-based sync
// barrier, never an arbitrary sleep (dashboards.spec pattern).
async function expectServerState<T>(
	read: (pool: Pool) => Promise<T>,
	expected: T,
): Promise<void> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await expect.poll(() => read(pool), { timeout: 15000 }).toEqual(expected);
	} finally {
		await pool.end();
	}
}

async function countRows(
	pool: Pool,
	sql: string,
	params: unknown[],
): Promise<number> {
	const rows = await pool.query<{ n: string }>(sql, params);
	return Number(rows.rows[0]?.n ?? -1);
}

// A workspace this user did NOT create, seeded with a list + task owned by the
// e2e system user, and a viewer membership for `userId`. Its own workspace (not
// the globally seeded shared one) so the role scenario neither depends on nor
// perturbs what other specs accumulate there.
async function seedViewerWorkspace(
	userId: string,
	names: { workspace: string; list: string; task: string },
): Promise<void> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		const workspaceId = crypto.randomUUID();
		const listId = crypto.randomUUID();
		await pool.query(
			`insert into workspace (id, name, owner_id, kind)
			 values ($1, $2, $3, 'shared')`,
			[workspaceId, names.workspace, SYSTEM_USER_ID],
		);
		await pool.query(
			`insert into list (id, workspace_id, owner_id, title, kind, sort_key)
			 values ($1, $2, $3, $4, 'tasks', 'a0')`,
			[listId, workspaceId, SYSTEM_USER_ID, names.list],
		);
		await pool.query(
			`insert into task (id, list_id, title, sort_key)
			 values ($1, $2, $3, 'a0')`,
			[crypto.randomUUID(), listId, names.task],
		);
		await pool.query(
			`insert into membership (id, user_id, workspace_id, role)
			 values ($1, $2, $3, 'viewer')`,
			[crypto.randomUUID(), userId, workspaceId],
		);
	} finally {
		await pool.end();
	}
}

// Gate per design 2.14: zero serious/critical violations. Moderate/minor logged
// only. Freeze animations so axe samples the settled frame (matches
// dashboards.spec exactly).
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

// Switch locale through the real switcher (writes the cookie the strategy chain
// reads first) and wait out Paraglide's reload -- locale.spec's mechanism, not
// a hand-rolled cookie.
async function switchLocale(
	page: Page,
	nativeName: string,
	locale: Locale,
	dir: "ltr" | "rtl",
): Promise<void> {
	const reloaded = page.waitForEvent("load");
	await page.getByTestId("language-switcher").click();
	await page.getByRole("option", { name: nativeName }).click();
	await reloaded;
	await expect(page.locator("html")).toHaveAttribute("lang", locale);
	await expect(page.locator("html")).toHaveAttribute("dir", dir);
	await waitWorkspaceReady(page);
}

// --- 1: the kebab opens, Escape closes it, focus lands back on the trigger ---
// Radix gives the focus return for free, so the assertion is not about Radix: it
// is the regression guard on the trigger wrapper, which is ours (Button +
// asChild) and would swallow the restore silently.
test("row menu: the kebab opens, Escape closes it and returns focus to the trigger", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("aff1"));
	const listName = uniqueName("Aff kebab");
	await createListDesktop(page, listName);

	const kebab = listRowKebab(page, listName);
	await expect(kebab).toHaveAttribute("aria-expanded", "false");

	await openRowMenu(kebab);
	await expect(page.getByTestId("row-action-rename")).toBeVisible();
	await expect(page.getByTestId("row-action-delete")).toBeVisible();

	await closeRowMenu(page);
	await expect(kebab).toHaveAttribute("aria-expanded", "false");
	await expect(kebab).toBeFocused();
});

// --- 2: destructive actions ask first, and Cancel really cancels ---
test("confirm: a list delete asks first and Cancel leaves the row untouched", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("aff2"));
	const listName = uniqueName("Aff cancel");
	await createListDesktop(page, listName);

	await openRowMenu(listRowKebab(page, listName));
	await page.getByTestId("row-action-delete").click();

	const dialog = page.getByTestId("confirm-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(listName);

	await page.getByTestId("confirm-cancel").click();
	await expect(dialog).toBeHidden();

	// Still in the sidebar, and still upstream: the client-only check alone would
	// also pass on a delete that was sent but had not yet round-tripped back.
	await expect(
		sidebarLists(page).getByRole("button", { name: listName, exact: true }),
	).toBeVisible();
	await expectServerState(
		(pool) =>
			countRows(pool, `select count(*) as n from list where title = $1`, [
				listName,
			]),
		1,
	);
});

// --- 3: accepted, the delete really happens -- list and its tasks ---
test("confirm: an accepted list delete removes the list and its tasks", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("aff3"));
	const listName = uniqueName("Aff delete");
	const taskName = uniqueName("Aff task");
	await createListDesktop(page, listName);
	await openListDesktop(page, listName);
	await addTask(page, taskName);
	await goToListsIndex(page);

	await openRowMenu(listRowKebab(page, listName));
	await page.getByTestId("row-action-delete").click();
	await expect(page.getByTestId("confirm-dialog")).toBeVisible();
	await page.getByTestId("confirm-accept").click();
	await expect(page.getByTestId("confirm-dialog")).toBeHidden();

	await expect(
		sidebarLists(page).getByRole("button", { name: listName, exact: true }),
	).toHaveCount(0);
	// list.delete removes the list's tasks before the list itself (mutators.ts
	// 1064-1073); asserting upstream is what proves the cascade rather than just
	// the row vanishing from a client that stopped syncing it.
	await expectServerState(
		(pool) =>
			countRows(
				pool,
				`select (select count(*) from list where title = $1)
				      + (select count(*) from task where title = $2) as n`,
				[listName, taskName],
			),
		0,
	);
});

// --- 4: permission held, state blocks -> shown, disabled, reason given ---
test("blocked: a folder with lists shows Delete disabled with its reason, and deletes once emptied", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("aff4"));
	const folderName = uniqueName("Aff blocked");
	const listName = uniqueName("Aff inside");
	await createListDesktop(page, listName);
	await createFolder(page, folderName);
	await moveListToFolder(page, listName, folderName);

	const folderKebab = kebabIn(sidebarLists(page), folderName);
	await openRowMenu(folderKebab);

	const blockedDelete = page.getByTestId("row-action-delete");
	// aria-disabled, NOT the native disabled attribute: Radix skips a natively
	// disabled item in keyboard navigation, so the user could never reach the
	// reason. Both halves are asserted so a regression to `disabled` fails here.
	await expect(blockedDelete).toHaveAttribute("aria-disabled", "true");
	await expect(blockedDelete).not.toHaveAttribute("disabled", /.*/);

	const reason = m.folder_delete_blocked({}, { locale: "en" });
	const describedBy = await blockedDelete.getAttribute("aria-describedby");
	expect(describedBy, "blocked item must name its reason element").toBeTruthy();
	// Attribute selector, not #id: useId mints ids containing colons, which are
	// not valid in a bare CSS id selector.
	await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(reason);
	await expect(blockedDelete).toContainText(reason);

	// A blocked item fires nothing and keeps the menu open, so a stale block can
	// never reach the mutator and surface its untranslated error instead.
	await blockedDelete.click();
	await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
	await expect(page.getByRole("menu").first()).toBeVisible();
	await closeRowMenu(page);

	// Emptied, the same folder deletes.
	await moveListToFolder(page, listName, null);
	await openRowMenu(folderKebab);
	const enabledDelete = page.getByTestId("row-action-delete");
	await expect(enabledDelete).not.toHaveAttribute("aria-disabled", "true");
	await enabledDelete.click();
	await expect(page.getByTestId("confirm-dialog")).toBeVisible();
	await page.getByTestId("confirm-accept").click();

	await expect(
		sidebarLists(page).getByText(folderName, { exact: true }),
	).toHaveCount(0);
	await expectServerState(
		(pool) =>
			countRows(pool, `select count(*) as n from folder where name = $1`, [
				folderName,
			]),
		0,
	);
});

// --- 5: New folder, and the move submenu actually moves ---
test("folders: New folder creates one and a list moves into it through the submenu", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("aff5"));
	const folderName = uniqueName("Aff folder");
	const listName = uniqueName("Aff mover");
	await createListDesktop(page, listName);

	await createFolder(page, folderName);
	await expect(
		sidebarLists(page).getByText(folderName, { exact: true }),
	).toBeVisible({ timeout: 15000 });

	await moveListToFolder(page, listName, folderName);

	// The join is the assertion: the list carries THIS folder's id, which a
	// sidebar text check (heading and list are siblings, not nested) cannot say.
	await expectServerState(
		(pool) =>
			countRows(
				pool,
				`select count(*) as n from list l
				 join folder f on f.id = l.folder_id
				 where l.title = $1 and f.name = $2`,
				[listName, folderName],
			),
		1,
	);

	// The folder's own menu now offers no destination for this list, and the
	// list's submenu no longer offers the folder it already sits in.
	await openRowMenu(listRowKebab(page, listName));
	await page
		.getByRole("menuitem", {
			name: m.action_move_to_folder({}, { locale: "en" }),
			exact: true,
		})
		.click();
	await expect(page.getByTestId("row-action-move-none")).toBeVisible();
	await expect(
		page.getByRole("menuitem", { name: folderName, exact: true }),
	).toHaveCount(0);
});

// --- 6: no permission -> the item is ABSENT, not disabled ---
// The strongest assertion in this file: a Viewer must not be offered a delete
// anywhere. Absence, deliberately not aria-disabled -- that is the other half of
// the rule and is covered by the folder scenario above.
test("roles: a Viewer is offered no Delete anywhere", async ({ page }) => {
	const userId = await signUp(page, uniqueEmail("aff6"));
	const names = {
		workspace: uniqueName("Aff viewer ws"),
		list: uniqueName("Aff viewer list"),
		task: uniqueName("Aff viewer task"),
	};
	await seedViewerWorkspace(userId, names);

	await page
		.getByRole("button", { name: names.workspace, exact: true })
		.click();
	await expect(
		sidebarLists(page).getByRole("button", { name: names.list, exact: true }),
	).toBeVisible({ timeout: 15000 });

	// Every list action gates on write or on owner-or-admin, so a Viewer's list
	// row offers nothing at all and RowActions renders null.
	await expect(listRowKebab(page, names.list)).toHaveCount(0);
	await expect(
		listRow(page, names.list).getByTestId("row-actions"),
	).toHaveCount(0);

	// The task row is the non-vacuous half: "Open" needs no role, so the Viewer
	// DOES get a menu there. Without this, an app that simply failed to sync
	// would pass the absence checks above for the wrong reason.
	await openListDesktop(page, names.list);
	const taskKebab = kebabIn(page.getByTestId("list"), names.task);
	await openRowMenu(taskKebab);
	await expect(page.getByTestId("row-action-open")).toBeVisible();
	await expect(page.getByTestId("row-action-delete")).toHaveCount(0);
	await expect(page.getByTestId("row-action-rename")).toHaveCount(0);
	await closeRowMenu(page);

	// Nothing anywhere on the surface offers a delete.
	await expect(page.getByTestId("row-action-delete")).toHaveCount(0);
});

// --- 6b: creation entry points follow the mutator, not the surface ---
// folder.create is unconditionally requireWrite, so the button goes. But
// view.create/dashboard.create only require a write role for scope "workspace",
// and every user owns their personal workspace as owner -- so both buttons stay,
// the Visibility->Workspace option stays reachable, and only the share-target
// picker narrows. Hiding those two would delete a legitimate Viewer capability.
test("roles: a Viewer keeps New view/New dashboard, loses New folder and this workspace as a share target", async ({
	page,
}) => {
	const userId = await signUp(page, uniqueEmail("aff6b"));
	const names = {
		workspace: uniqueName("Aff gate ws"),
		list: uniqueName("Aff gate list"),
		task: uniqueName("Aff gate task"),
	};
	await seedViewerWorkspace(userId, names);

	await page
		.getByRole("button", { name: names.workspace, exact: true })
		.click();
	await expect(
		sidebarLists(page).getByRole("button", { name: names.list, exact: true }),
	).toBeVisible({ timeout: 15000 });

	await expect(page.getByTestId("new-folder")).toHaveCount(0);
	await expect(page.getByTestId("new-view")).toBeVisible();
	await expect(page.getByTestId("new-dashboard")).toBeVisible();

	await page.getByTestId("new-view").click();
	await page.getByRole("combobox", { name: m.field_visibility() }).click();
	await page.getByRole("option", { name: m.visibility_workspace() }).click();
	await page.getByRole("combobox", { name: m.field_shared_in() }).click();
	// Exactly the caller's own personal workspace: present proves the picker is
	// populated at all, so the absence below is not vacuous.
	await expect(page.getByRole("option")).toHaveCount(1);
	await expect(
		page.getByRole("option", { name: names.workspace, exact: true }),
	).toHaveCount(0);
});

// --- 7: right-click is the same menu ---
test("right-click opens the same row menu as the kebab", async ({ page }) => {
	await signUp(page, uniqueEmail("aff7"));
	const listName = uniqueName("Aff context");
	await createListDesktop(page, listName);

	await openRowMenu(listRowKebab(page, listName));
	const viaKebab = await page
		.getByRole("menu")
		.first()
		.getByRole("menuitem")
		.count();
	// Guards the comparison below from passing on two empty menus.
	expect(viaKebab).toBeGreaterThan(0);
	await expect(page.getByTestId("row-action-delete")).toBeVisible();
	await closeRowMenu(page);

	await listRow(page, listName).click({ button: "right" });
	const contextMenu = page.getByRole("menu").first();
	await expect(contextMenu).toBeVisible();
	await expect(contextMenu.getByRole("menuitem")).toHaveCount(viaKebab);
	await expect(page.getByTestId("row-action-delete")).toBeVisible();
	await expect(page.getByTestId("row-action-rename")).toBeVisible();
	await closeRowMenu(page);
});

// --- 8: the axe merge gate on every new surface ---
test("a11y: open row menu, confirm dialog, label manager and template manager", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("aff8"));
	const listName = uniqueName("Aff axe");
	const labelName = uniqueName("Aff label");
	await createListDesktop(page, listName);

	await openRowMenu(listRowKebab(page, listName));
	await expectNoSeriousA11y(page, "row menu (open)");

	await page.getByTestId("row-action-delete").click();
	await expect(page.getByTestId("confirm-dialog")).toBeVisible();
	await expectNoSeriousA11y(page, "confirm dialog");
	await page.getByTestId("confirm-cancel").click();
	await expect(page.getByTestId("confirm-dialog")).toBeHidden();

	// Populate both managers: an empty-state axe run would not cover the row
	// markup the kebab lives in, which is the point of the gate here.
	await openRowMenu(listRowKebab(page, listName));
	await page.getByTestId("row-action-template").click();
	await expect(page.getByRole("menu")).toHaveCount(0);

	await page.getByTestId("label-new").click();
	await page.getByTestId("label-name-input").fill(labelName);
	await page.getByTestId("label-name-save").click();
	await expect(page.getByTestId("label-name-input")).toBeHidden();

	await expect(page.getByTestId("label-manager")).toBeVisible();
	await expect(page.getByTestId("label-row").first()).toBeVisible({
		timeout: 15000,
	});
	await expectNoSeriousA11y(page, "label manager");

	await expect(page.getByTestId("template-manager")).toBeVisible();
	await expect(page.getByTestId("template-row").first()).toBeVisible({
		timeout: 15000,
	});
	await expectNoSeriousA11y(page, "template manager");
});

// --- 9: the same two behaviours under RTL ---
// Scenarios 1 and 2 repeated in Arabic. The menu is a body portal positioned by
// Radix, so a direction regression shows up as a menu that opens but whose
// trigger never gets focus back, or a dialog whose buttons are unreachable.
test("rtl: the row menu and the confirm dialog behave the same in Arabic", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("aff9"));
	await waitWorkspaceReady(page);
	await switchLocale(page, "العربية", "ar", "rtl");

	const listName = uniqueName("Aff rtl");
	await createListDesktop(page, listName, "ar");

	const kebab = listRowKebab(page, listName, "ar");
	await openRowMenu(kebab);
	await expect(page.getByTestId("row-action-rename")).toBeVisible();
	await closeRowMenu(page);
	await expect(kebab).toBeFocused();

	await openRowMenu(kebab);
	await page.getByTestId("row-action-delete").click();
	const dialog = page.getByTestId("confirm-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(listName);
	await expect(page.getByTestId("confirm-cancel")).toHaveText(
		m.confirm_cancel({}, { locale: "ar" }),
	);
	await page.getByTestId("confirm-cancel").click();
	await expect(dialog).toBeHidden();
	await expect(
		sidebarLists(page, "ar").getByRole("button", {
			name: listName,
			exact: true,
		}),
	).toBeVisible();

	await expectNoSeriousA11y(page, "row menu + confirm (ar)");
});
