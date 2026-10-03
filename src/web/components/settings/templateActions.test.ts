import { expect, test, vi } from "vitest";
import type { Template } from "../../../zero/schema.gen.ts";
import { templateActions } from "./templateActions.ts";

const imported: Template = {
	id: "imported",
	workspaceId: "space",
	kind: "list",
	name: "Imported",
	icon: null,
	provenanceRedactedAt: null,
	content: {},
	createdBy: "operator",
	historicalCreatorKind: "source_claim",
	historicalCreatorName: "Current person",
	importedAt: 0,
};
const handlers = { use: vi.fn(), remove: vi.fn() };
test("source-reported template creators never confer delete authority on a matching local person", () => {
	const actions = templateActions({
		template: imported,
		role: "member",
		userId: "matching-person",
		handlers,
	});
	expect(actions.find((action) => action.id === "delete")?.hidden).toBe(true);
	expect(actions.find((action) => action.id === "use")?.hidden).toBe(false);
});
test("operational creator and admin permissions remain observable for imported template details", () => {
	for (const [role, userId] of [
		["member", "operator"],
		["admin", "administrator"],
	] as const)
		expect(
			templateActions({ template: imported, role, userId, handlers }).find(
				(action) => action.id === "delete",
			)?.hidden,
		).toBe(false);
	expect(
		templateActions({
			template: imported,
			role: "viewer",
			userId: "operator",
			handlers,
		}).find((action) => action.id === "delete")?.hidden,
	).toBe(true);
});
