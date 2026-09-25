import { describe, expect, test } from "vitest";
import { validateImportGraphV2 } from "./graph-v2.ts";
import type { PortableExportV2, PortableRowsV2 } from "./v2.ts";

const date = "2026-01-01T00:00:00.000Z";
const namespace = "fefc017c-229a-4eb8-8d3d-e1430258c5f4";

function sourceRef<
	Collection extends "comments" | "templates" | "completionEvents",
>(collection: Collection, id: string) {
	return { namespace, collection, id };
}

function event(
	id: string,
	action: "complete" | "reopen" | "skip" = "complete",
): PortableRowsV2["completionEvents"] {
	return {
		id,
		sourceRef: sourceRef("completionEvents", id),
		taskId: "task",
		occurredAt: date,
		actor: { kind: "native_user", principalId: "self" },
		origin: { kind: "native", mechanism: "member_mutation" },
		action,
		beforeDueAt: null,
		beforeDueAllDay: false,
		beforeDone: false,
		afterDueAt: null,
		afterDone: true,
	};
}

function fixture(): PortableExportV2 {
	return {
		format: "ditero",
		schemaVersion: 2,
		exportedAt: date,
		sourceUserId: "self",
		sourceNamespace: namespace,
		boundaries: {
			attachmentContent: "excluded",
			encryptionKeys: "excluded",
			credentials: "excluded",
			managedAccounts: "excluded",
			restoreSupported: false,
			taskHistory: "recorded-events-only",
		},
		data: {
			principals: [{ id: "self", name: "Self" }],
			workspaces: [
				{ id: "ws", name: "Workspace", ownerId: "self", kind: "shared" },
			],
			memberships: [
				{ id: "member", userId: "self", workspaceId: "ws", role: "owner" },
			],
			folders: [],
			lists: [
				{
					id: "list",
					workspaceId: "ws",
					ownerId: "self",
					title: "List",
					kind: "tasks",
					icon: null,
					folderId: null,
					sortKey: "a",
					completedDisplay: "show",
				},
			],
			tasks: [
				{
					id: "task",
					listId: "list",
					title: "Task",
					done: false,
					notes: null,
					dueAt: null,
					dueAllDay: false,
					priority: 0,
					completedAt: null,
					sortKey: "a",
					parentId: null,
					quantity: null,
					unit: null,
					category: null,
					rrule: null,
					recurrenceRelative: false,
					reminderTime: null,
					repeatEveryMin: null,
					maxRepeats: null,
					fallbackUserId: null,
					urgent: false,
				},
			],
			labels: [],
			taskLabels: [],
			templates: [
				{
					id: "template",
					sourceRef: sourceRef("templates", "template"),
					workspaceId: "ws",
					kind: "task",
					name: "Template",
					icon: null,
					content: { kind: "task" },
					creator: { kind: "unknown" },
				},
			],
			assignments: [],
			comments: [
				{
					id: "comment",
					sourceRef: sourceRef("comments", "comment"),
					taskId: "task",
					author: {
						kind: "source_claim",
						sourceNamespace: namespace,
						sourcePrincipalId: null,
						displayName: "Former writer",
					},
					body: "Historical text",
					createdAt: date,
					editedAt: null,
				},
			],
			habitLogs: [],
			completionEvents: [event("event")],
			views: [],
			dashboards: [],
			userPrefs: [],
			focusSessions: [],
			karma: [],
			karmaEvents: [],
			attachments: [
				{
					id: "attachment",
					workspaceId: "ws",
					parentKind: "comment",
					parentId: "comment",
					keyVersion: 1,
					declaredBytes: 1,
					observedBytes: 1,
					ciphertextSha256: null,
					thumbnailDeclaredBytes: null,
					thumbnailObservedBytes: null,
					thumbnailCiphertextSha256: null,
					uploadedBy: "self",
					createdAt: date,
					committedAt: date,
				},
			],
		},
	};
}

describe("v2 import graph", () => {
	test("accepts source claims and unknown authors without local principal lookup, including a comment attachment", () => {
		const source = fixture();
		source.data.templates[0].creator = {
			kind: "source_claim",
			sourceNamespace: namespace,
			sourcePrincipalId: "",
			displayName: null,
		};
		source.data.completionEvents[0].actor = { kind: "unknown" };
		const before = structuredClone(source);
		expect(validateImportGraphV2(source)).toEqual({
			valid: true,
			errors: [],
			warnings: [],
		});
		expect(source).toEqual(before);
		source.data.attachments[0].parentId = "missing";
		expect(validateImportGraphV2(source).warnings).toEqual([
			{ code: "orphan-attachment", path: "data.attachments[0].parentId" },
		]);
	});

	test("requires native authors and creators to exist in the exported principals", () => {
		const source = fixture();
		source.data.comments[0].author = {
			kind: "native_user",
			principalId: "absent",
		};
		source.data.templates[0].creator = {
			kind: "native_user",
			principalId: "absent",
		};
		source.data.completionEvents[0].actor = {
			kind: "native_user",
			principalId: "absent",
		};
		expect(validateImportGraphV2(source).errors).toEqual([
			{
				code: "missing-reference",
				path: "data.templates[0].creator.principalId",
			},
			{
				code: "missing-reference",
				path: "data.comments[0].author.principalId",
			},
			{
				code: "missing-reference",
				path: "data.completionEvents[0].actor.principalId",
			},
		]);
	});

	test("checks event task references without checking current list kind after a move", () => {
		const source = fixture();
		source.data.completionEvents.push({
			id: "habit-event",
			sourceRef: sourceRef("completionEvents", "habit-event"),
			taskId: "task",
			occurredAt: date,
			actor: { kind: "unknown" },
			origin: { kind: "unknown" },
			action: "habit_set",
			habitDate: "2026-01-01",
			beforeHabitStatus: null,
			afterHabitStatus: "done",
		});
		expect(validateImportGraphV2(source)).toEqual({
			valid: true,
			errors: [],
			warnings: [],
		});
		source.data.lists[0].kind = "habits";
		expect(validateImportGraphV2(source)).toEqual({
			valid: true,
			errors: [],
			warnings: [],
		});
		source.data.completionEvents[0].taskId = "missing";
		expect(validateImportGraphV2(source).errors).toContainEqual({
			code: "missing-reference",
			path: "data.completionEvents[0].taskId",
		});
	});

	test("treats empty IDs and source-ref IDs as values, including duplicate detection", () => {
		const source = fixture();
		source.sourceUserId = "";
		source.data.principals[0].id = "";
		source.data.workspaces[0].ownerId = "";
		source.data.memberships[0].userId = "";
		source.data.lists[0].ownerId = "";
		source.data.attachments[0].uploadedBy = "";
		source.data.tasks[0].id = "";
		source.data.comments[0].taskId = "";
		source.data.completionEvents[0].taskId = "";
		source.data.completionEvents[0].actor = {
			kind: "native_user",
			principalId: "",
		};
		source.data.comments[0].sourceRef.id = "";
		source.data.templates[0].sourceRef.id = "";
		expect(validateImportGraphV2(source).errors).toEqual([]);
		source.data.comments.push({
			...source.data.comments[0],
			id: "second",
			sourceRef: { ...source.data.comments[0].sourceRef },
		});
		expect(validateImportGraphV2(source).errors).toContainEqual({
			code: "duplicate-source-reference",
			path: "data.comments[1].sourceRef",
		});
		source.data.completionEvents.push({ ...source.data.completionEvents[0] });
		expect(validateImportGraphV2(source).errors).toContainEqual({
			code: "duplicate-id",
			path: "data.completionEvents[1].id",
		});
	});
	test("requires each source reference to name its actual collection", () => {
		const source = fixture();
		Object.assign(source.data.comments[0].sourceRef, {
			collection: "templates",
		});
		expect(validateImportGraphV2(source).errors).toEqual([
			{
				code: "source-reference-collection-mismatch",
				path: "data.comments[0].sourceRef.collection",
			},
		]);
	});
	test("compares UUID namespace case without merging distinct namespaces", () => {
		const source = fixture();
		source.data.comments.push({
			...source.data.comments[0],
			id: "second",
			sourceRef: {
				...source.data.comments[0].sourceRef,
				namespace: namespace.toUpperCase(),
			},
		});
		expect(validateImportGraphV2(source).errors).toContainEqual({
			code: "duplicate-source-reference",
			path: "data.comments[1].sourceRef",
		});
		expect(source.data.comments[1].sourceRef.namespace).toBe(
			namespace.toUpperCase(),
		);
		source.data.comments[1].sourceRef.namespace =
			`a${namespace.slice(1)}`.toUpperCase();
		expect(validateImportGraphV2(source).errors).toEqual([]);
	});

	test("uses the shared combined finding cap for additional event checks", () => {
		const source = fixture();
		source.data.completionEvents = Array.from({ length: 1_001 }, (_, i) => ({
			...event(String(i)),
			taskId: "missing",
		}));
		const result = validateImportGraphV2(source);
		expect(result.valid).toBe(false);
		expect(result.errors).toHaveLength(1_000);
		expect(result.errors.at(-1)).toEqual({
			code: "finding-limit",
			path: "data",
		});
	});
});
