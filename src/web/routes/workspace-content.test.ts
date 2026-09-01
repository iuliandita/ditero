import { describe, expect, test } from "vitest";
import {
	type WorkspaceContent,
	type WorkspaceContentAction,
	workspaceContentReducer,
} from "./workspace-content.ts";

type EntityContent = Extract<WorkspaceContent, { id: string }>;
type EntityKind = EntityContent["kind"];

const states = [
	{ kind: "home" },
	{ kind: "list", id: "list-a" },
	{ kind: "view", id: "view-a" },
	{ kind: "dashboard", id: "dashboard-a" },
	{ kind: "settings" },
] satisfies WorkspaceContent[];

const entityStates = states.filter(
	(state): state is EntityContent => "id" in state,
);

const destinations = [
	{ kind: "home" },
	{ kind: "list", id: "list-b" },
	{ kind: "view", id: "view-b" },
	{ kind: "dashboard", id: "dashboard-b" },
	{ kind: "settings" },
] satisfies WorkspaceContentAction[];

function close(target: EntityKind, id: string): WorkspaceContentAction {
	return { kind: "close", target, id };
}

describe("workspaceContentReducer", () => {
	test.each(destinations)("$kind navigation replaces every state", (next) => {
		for (const current of states) {
			expect(workspaceContentReducer(current, next)).toEqual(next);
		}
	});

	test.each(entityStates)("matching $kind close returns home", (current) => {
		expect(
			workspaceContentReducer(current, close(current.kind, current.id)),
		).toEqual({ kind: "home" });
	});

	test.each(
		entityStates,
	)("$kind close with a different id preserves the current state", (current) => {
		expect(workspaceContentReducer(current, close(current.kind, "other"))).toBe(
			current,
		);
	});

	test.each(
		entityStates,
	)("$kind state ignores close actions for other content kinds", (current) => {
		for (const target of entityStates.map((state) => state.kind)) {
			if (target === current.kind) continue;
			expect(workspaceContentReducer(current, close(target, current.id))).toBe(
				current,
			);
		}
	});

	test.each([
		{ kind: "home" },
		{ kind: "settings" },
	] satisfies WorkspaceContent[])("$kind ignores entity close actions", (current) => {
		for (const target of entityStates.map((state) => state.kind)) {
			expect(workspaceContentReducer(current, close(target, "any"))).toBe(
				current,
			);
		}
	});
});
