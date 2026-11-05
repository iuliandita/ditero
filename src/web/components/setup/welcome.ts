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
// workspace, or a shared list elsewhere, never counts as "their" content.
export function offersSetupWelcome({
	workspaceKind,
	role,
	listCount,
	outcome,
	authoritative,
	managed,
	dismissed,
}: {
	workspaceKind: string | null | undefined;
	role: string | undefined;
	listCount: number;
	outcome: AccountSetupOutcome | undefined;
	authoritative: boolean;
	managed: boolean;
	dismissed: boolean;
}): boolean {
	return (
		!dismissed &&
		authoritative &&
		!managed &&
		outcome === "pending" &&
		workspaceKind === "personal" &&
		role === "owner" &&
		listCount === 0
	);
}
