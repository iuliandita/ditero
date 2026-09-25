import { describe, expect, test } from "vitest";
import type { PortableCompletionEventV2, PortableExportV2 } from "./v2.ts";
import { PortableExportValidationError } from "./validate.ts";
import { parsePortableExportV2 } from "./validate-v2.ts";

const stamp = "2026-09-25T10:00:00.000Z";
const namespace = "8f63b9c0-6ac5-4a79-98c2-f0582d21056e";
const sourceRef = <
	Collection extends "comments" | "templates" | "completionEvents",
>(
	collection: Collection,
) => ({
	namespace,
	collection,
	id: "",
});

function fixture(): PortableExportV2 {
	return {
		format: "ditero",
		schemaVersion: 2,
		exportedAt: stamp,
		sourceUserId: "",
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
			principals: [{ id: "", name: "Reader" }],
			workspaces: [],
			memberships: [],
			folders: [],
			lists: [],
			tasks: [],
			labels: [],
			taskLabels: [],
			templates: [
				{
					id: "",
					workspaceId: "",
					kind: "task",
					name: "Walk",
					icon: null,
					content: { kind: "task", task: { title: "Walk" } },
					sourceRef: sourceRef("templates"),
					creator: { kind: "native_user", principalId: "" },
				},
			],
			assignments: [],
			comments: [
				{
					id: "",
					taskId: "",
					body: "History matters",
					createdAt: stamp,
					editedAt: null,
					sourceRef: sourceRef("comments"),
					author: { kind: "unknown" },
				},
			],
			habitLogs: [],
			views: [],
			dashboards: [],
			userPrefs: [],
			focusSessions: [],
			karma: [],
			karmaEvents: [],
			attachments: [],
			completionEvents: [],
		},
	};
}

function taskEvent(
	action: "complete" | "reopen" | "skip",
): PortableCompletionEventV2 {
	return {
		id: "",
		sourceRef: sourceRef("completionEvents"),
		taskId: "",
		occurredAt: "+010000-01-01T00:00:00.000Z",
		actor: { kind: "native_user", principalId: "" },
		origin: { kind: "native", mechanism: "member_mutation" },
		action,
		beforeDueAt: null,
		beforeDueAllDay: false,
		beforeDone: action === "reopen",
		afterDueAt: action === "skip" ? stamp : null,
		afterDone: action === "complete",
	};
}

function habitEvent(
	action: "habit_set" | "habit_unlog",
): PortableCompletionEventV2 {
	return {
		id: "habit-event",
		sourceRef: sourceRef("completionEvents"),
		taskId: "habit",
		occurredAt: stamp,
		actor: { kind: "unknown" },
		origin: { kind: "unknown" },
		action,
		habitDate: "2024-02-29",
		beforeHabitStatus: action === "habit_unlog" ? "skipped" : null,
		afterHabitStatus: action === "habit_set" ? "done" : null,
	};
}

function parse(value: unknown): PortableExportV2 {
	return parsePortableExportV2(JSON.stringify(value));
}

describe("portable v2 validation", () => {
	test("preserves all actions, nullable payloads, empty IDs, and exact document content", () => {
		const input = fixture();
		input.data.completionEvents = [
			taskEvent("complete"),
			taskEvent("reopen"),
			taskEvent("skip"),
			habitEvent("habit_set"),
			{
				id: "habit-unlog",
				sourceRef: sourceRef("completionEvents"),
				taskId: "habit",
				occurredAt: stamp,
				actor: {
					kind: "source_claim",
					sourceNamespace: namespace,
					sourcePrincipalId: "",
					displayName: null,
				},
				origin: { kind: "source_claim", mechanism: null, label: null },
				action: "habit_unlog",
				habitDate: "2024-02-29",
				beforeHabitStatus: "skipped",
				afterHabitStatus: null,
			},
		];
		expect(parse(input)).toEqual(input);
		input.data.completionEvents[4] = {
			...input.data.completionEvents[4],
			actor: {
				kind: "source_claim",
				sourceNamespace: namespace,
				sourcePrincipalId: null,
				displayName: "Former member",
			},
		};
		expect(parse(input)).toEqual(input);
	});

	test("rejects unsupported document fields, bounds, and v1 identity fields", () => {
		for (const mutate of [
			(v: PortableExportV2) =>
				Object.assign(v, { sourceNamespace: "not-a-uuid" }),
			(v: PortableExportV2) => Object.assign(v, { schemaVersion: 1 }),
			(v: PortableExportV2) =>
				Object.assign(v.boundaries, {
					taskHistory: "current-state-and-habit-logs",
				}),
			(v: PortableExportV2) => Object.assign(v, { extra: true }),
			(v: PortableExportV2) => Object.assign(v.data, { extra: [] }),
			(v: PortableExportV2) =>
				Object.assign(v.data.comments[0] ?? {}, { authorId: "" }),
			(v: PortableExportV2) =>
				Object.assign(v.data.templates[0] ?? {}, { createdBy: "" }),
			(v: PortableExportV2) =>
				Object.assign(v.data.comments[0]?.sourceRef ?? {}, {
					collection: "templates",
				}),
			(v: PortableExportV2) =>
				Object.assign(v.data.templates[0]?.sourceRef ?? {}, { extra: "x" }),
		]) {
			const value = fixture();
			mutate(value);
			expect(() => parse(value)).toThrow(PortableExportValidationError);
		}
	});

	test("rejects extra, missing, and wrong-typed fields in author and origin unions", () => {
		for (const author of [
			{ kind: "native_user" },
			{ kind: "native_user", principalId: "", displayName: "extra" },
			{ kind: "unknown", principalId: "" },
			{
				kind: "source_claim",
				sourceNamespace: namespace,
				sourcePrincipalId: null,
			},
			{
				kind: "source_claim",
				sourceNamespace: namespace,
				sourcePrincipalId: null,
				displayName: "x".repeat(513),
			},
			{
				kind: "source_claim",
				sourceNamespace: "bad",
				sourcePrincipalId: "",
				displayName: null,
			},
		]) {
			const value = fixture();
			Object.assign(value.data.comments[0] ?? {}, { author });
			expect(() => parse(value), JSON.stringify(author)).toThrow();
		}
		for (const origin of [
			{ kind: "native", mechanism: null },
			{ kind: "native", mechanism: "import" },
			{ kind: "source_claim", mechanism: "import", label: null },
			{ kind: "source_claim", mechanism: null },
			{ kind: "source_claim", mechanism: null, label: "x".repeat(129) },
			{ kind: "unknown", mechanism: null },
		]) {
			const value = fixture();
			value.data.completionEvents = [
				{ ...taskEvent("complete"), origin } as PortableCompletionEventV2,
			];
			expect(() => parse(value), JSON.stringify(origin)).toThrow();
		}
	});

	test("enforces SQL-equivalent task and habit transitions and exact payload fields", () => {
		for (const [action, update] of [
			["complete", { beforeDone: true }],
			["reopen", { beforeDone: false }],
			["reopen", { afterDone: true }],
			["skip", { afterDone: true }],
			["skip", { afterDueAt: null }],
			["complete", { habitDate: "2024-02-29" }],
			["complete", { beforeDueAllDay: null }],
			["complete", { occurredAt: "2026-09-25T10:00:00Z" }],
		] as const) {
			const value = fixture();
			value.data.completionEvents = [
				{ ...taskEvent(action), ...update } as PortableCompletionEventV2,
			];
			expect(
				() => parse(value),
				`${action}: ${JSON.stringify(update)}`,
			).toThrow();
		}
		for (const [action, beforeHabitStatus, afterHabitStatus] of [
			["habit_set", null, null],
			["habit_set", "done", "done"],
			["habit_unlog", null, null],
			["habit_unlog", "done", "skipped"],
		] as const) {
			const value = fixture();
			value.data.completionEvents = [
				{
					...habitEvent(action),
					beforeHabitStatus,
					afterHabitStatus,
				} as PortableCompletionEventV2,
			];
			expect(() => parse(value)).toThrow();
		}
	});

	test("rejects missing and extra event fields without rewriting nulls", () => {
		for (const mutate of [
			(event: Record<string, unknown>) =>
				Reflect.deleteProperty(event, "beforeDone"),
			(event: Record<string, unknown>) =>
				Object.assign(event, { afterDueAt: undefined }),
			(event: Record<string, unknown>) =>
				Object.assign(event, { afterDone: null }),
			(event: Record<string, unknown>) =>
				Object.assign(event, { habitDate: "2024-02-29" }),
			(event: Record<string, unknown>) => Object.assign(event, { extra: "x" }),
		]) {
			const value = fixture();
			const event = taskEvent("complete");
			mutate(event as unknown as Record<string, unknown>);
			value.data.completionEvents = [event];
			expect(() => parse(value)).toThrow(PortableExportValidationError);
		}
		const habit = fixture();
		const event = habitEvent("habit_set");
		Reflect.deleteProperty(event, "afterHabitStatus");
		habit.data.completionEvents = [event];
		expect(() => parse(habit)).toThrow(PortableExportValidationError);
	});

	test("includes completion events in the shared row and array limits", () => {
		const value = fixture();
		value.data.completionEvents = Array(50_000).fill(taskEvent("complete"));
		expect(() => parse(value)).toThrowError(/row limit/);
		const nested = fixture();
		const nestedEvent = taskEvent("complete");
		Object.assign(nestedEvent, { extra: Array(50_001).fill(0) });
		nested.data.completionEvents = [nestedEvent];
		expect(() => parse(nested)).toThrowError(/array limit/);
	});
});
