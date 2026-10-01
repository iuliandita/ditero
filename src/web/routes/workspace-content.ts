export type WorkspaceContent =
	| { kind: "home" }
	// Mobile Lists tab; desktop keeps its index in the sidebar.
	| { kind: "index" }
	| { kind: "list"; id: string }
	| { kind: "view"; id: string }
	| { kind: "dashboard"; id: string }
	| { kind: "settings" };

type EntityKind = Extract<WorkspaceContent, { id: string }>["kind"];

export type WorkspaceContentAction =
	| WorkspaceContent
	| { kind: "close"; target: EntityKind; id: string };

export function workspaceContentReducer(
	state: WorkspaceContent,
	action: WorkspaceContentAction,
): WorkspaceContent {
	if (action.kind !== "close") return action;
	if (!("id" in state)) return state;
	return state.kind === action.target && state.id === action.id
		? { kind: "home" }
		: state;
}
