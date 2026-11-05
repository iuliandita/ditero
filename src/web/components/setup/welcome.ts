import type { AccountSetupOutcome } from "../../../domain/account-setup.ts";

export const SETUP_WELCOME_KEY = "ditero.setup-welcome-dismissed";

function key(scope: string) {
	return scope ? `${SETUP_WELCOME_KEY}.${scope}` : null;
}

export function loadSetupWelcomeDismissed(
	scope: string,
	store: Pick<Storage, "getItem"> | null = safeStorage(),
): boolean {
	const k = key(scope);
	if (!k || !store) return false;
	try {
		return store.getItem(k) === "1";
	} catch {
		return false;
	}
}

export function saveSetupWelcomeDismissed(
	scope: string,
	store: Pick<Storage, "setItem"> | null = safeStorage(),
): void {
	const k = key(scope);
	if (!k || !store) return;
	try {
		store.setItem(k, "1");
	} catch {
		/* The dismissal still holds for this session. */
	}
}

function safeStorage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

// The welcome belongs to the user's own, still-empty personal space. A shared
// workspace, or a shared list elsewhere, never counts as "their" content. Zero
// lists only counts once the list query is complete, not while it still loads.
export function offersSetupWelcome({
	workspaceKind,
	role,
	listCount,
	outcome,
	authoritative,
	listsReady,
	managed,
	dismissed,
}: {
	workspaceKind: string | null | undefined;
	role: string | undefined;
	listCount: number;
	outcome: AccountSetupOutcome | undefined;
	authoritative: boolean;
	listsReady: boolean;
	managed: boolean;
	dismissed: boolean;
}): boolean {
	return (
		!dismissed &&
		authoritative &&
		listsReady &&
		!managed &&
		outcome === "pending" &&
		workspaceKind === "personal" &&
		role === "owner" &&
		listCount === 0
	);
}

export type SetupArrival = { workspaceId: string; listId: string };

// The created list syncs in after setup completes. Any navigation the user makes
// in the meantime cancels the pending arrival so it cannot pull them back.
export function setupArrivalReducer(
	_state: SetupArrival | null,
	action: { kind: "arrive"; arrival: SetupArrival } | { kind: "cancel" },
): SetupArrival | null {
	return action.kind === "arrive" ? action.arrival : null;
}

export function syncedSetupArrival(
	arrival: SetupArrival | null,
	lists: readonly { id: string }[],
): SetupArrival | null {
	return arrival && lists.some((list) => list.id === arrival.listId)
		? arrival
		: null;
}
