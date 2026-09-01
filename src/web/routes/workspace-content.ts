export type WorkspaceContent =
	| { kind: "home" }
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
	if (state.kind === "home" || state.kind === "settings") return state;
	return state.kind === action.target && state.id === action.id
		? { kind: "home" }
		: state;
}
