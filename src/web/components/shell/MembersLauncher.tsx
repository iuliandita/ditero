import { useSyncExternalStore } from "react";

// Lets a deep surface (the task detail's context line) open the members sheet
// of the active workspace. Null when there is nobody to manage, so no one gets
// a button that opens an empty roster.
type MembersLauncher = { workspaceId: string; open: () => void } | null;

let current: MembersLauncher = null;
const listeners = new Set<() => void>();

export function publishMembersLauncher(next: MembersLauncher) {
	current = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useMembersLauncher(workspaceId: string): (() => void) | null {
	const launcher = useSyncExternalStore(
		subscribe,
		() => current,
		() => null,
	);
	return launcher?.workspaceId === workspaceId ? launcher.open : null;
}
