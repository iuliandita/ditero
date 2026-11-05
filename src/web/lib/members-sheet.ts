const EVENT = "ditero:open-members";

// The task detail can sit outside the route that owns the Members sheet and
// may show a task from another workspace than the active one, so it asks by
// workspace id instead of receiving a callback through every parent.
export function requestMembersSheet(workspaceId: string): void {
	window.dispatchEvent(new CustomEvent(EVENT, { detail: workspaceId }));
}

export function onMembersSheetRequest(
	handler: (workspaceId: string) => void,
): () => void {
	function listener(event: Event) {
		handler((event as CustomEvent<string>).detail);
	}
	window.addEventListener(EVENT, listener);
	return () => window.removeEventListener(EVENT, listener);
}
