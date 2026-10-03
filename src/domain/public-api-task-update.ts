import { z } from "zod";
import { PUBLIC_API_ID, PublicApiError } from "./public-api.ts";

const instant = z.iso.datetime({ offset: true });
export const apiTaskSnapshotSchema = z
	.object({
		version: z.literal(1),
		taskId: PUBLIC_API_ID,
		listId: PUBLIC_API_ID,
		workspaceId: PUBLIC_API_ID,
		title: z.string(),
		notes: z.string().nullable(),
		dueAt: instant.nullable(),
		dueAllDay: z.boolean(),
		priority: z.number().int(),
		createdAt: instant.nullable(),
		done: z.boolean(),
		completedAt: instant.nullable(),
		listKind: z.enum(["tasks", "shopping", "checklist", "project", "habits"]),
		rrule: z.string().nullable(),
		recurrenceRelative: z.boolean(),
		recurrenceAnchorAt: instant.nullable(),
		recurrenceConsumed: z.number().int().nullable(),
	})
	.strict();
export type ApiTaskSnapshot = z.infer<typeof apiTaskSnapshotSchema>;
const stateToken = z.string().regex(/^[a-f0-9]{64}$/);
export const apiTaskObservationSchema = z
	.object({ snapshot: apiTaskSnapshotSchema, stateToken })
	.strict();

export const apiTaskUpdateSchema = z
	.object({
		listId: PUBLIC_API_ID,
		expectedState: stateToken,
		patch: z
			.object({
				title: z.string().trim().min(1).max(500).optional(),
				notes: z.string().max(32_768).nullable().optional(),
				dueAt: instant
					.transform((value) => new Date(value).toISOString())
					.nullable()
					.optional(),
				dueAllDay: z.boolean().optional(),
				priority: z.number().int().min(0).max(3).optional(),
			})
			.strict()
			.refine(
				(value) => Object.values(value).some((field) => field !== undefined),
				"A scalar patch is required",
			),
	})
	.strict();
export type ApiTaskUpdate = z.infer<typeof apiTaskUpdateSchema>;

function ownFields(
	value: unknown,
	allowed: readonly string[],
): value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getOwnPropertySymbols(value).length
	)
		return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return Object.entries(Object.getOwnPropertyDescriptors(value)).every(
		([key, descriptor]) =>
			allowed.includes(key) &&
			descriptor.enumerable &&
			"value" in descriptor &&
			descriptor.value !== undefined,
	);
}

export function parseApiTaskUpdate(value: unknown): ApiTaskUpdate {
	if (
		!ownFields(value, ["listId", "expectedState", "patch"]) ||
		!ownFields(value.patch, [
			"title",
			"notes",
			"dueAt",
			"dueAllDay",
			"priority",
		])
	)
		throw new PublicApiError(400, "invalid-task", "Invalid task update fields");
	const parsed = apiTaskUpdateSchema.safeParse(value);
	if (!parsed.success)
		throw new PublicApiError(400, "invalid-task", "Invalid task update fields");
	return parsed.data;
}

export function canonicalApiTaskUpdate(
	taskId: string,
	input: ApiTaskUpdate,
): string {
	return JSON.stringify({
		operation: "task.update.v1",
		taskId,
		...parseApiTaskUpdate(input),
	});
}

export function canonicalApiTaskSnapshot(value: ApiTaskSnapshot): string {
	const snapshot = apiTaskSnapshotSchema.parse(value);
	for (const key of [
		"dueAt",
		"createdAt",
		"completedAt",
		"recurrenceAnchorAt",
	] as const) {
		const value = snapshot[key];
		if (value !== null) snapshot[key] = new Date(value).toISOString();
	}
	return JSON.stringify(snapshot);
}
