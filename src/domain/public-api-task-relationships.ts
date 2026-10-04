import { z } from "zod";
import { PUBLIC_API_ID, PublicApiError } from "./public-api.ts";

const id = PUBLIC_API_ID.refine(
	(value) => !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value),
);
const ids = (maximum: number) =>
	z
		.array(id)
		.max(maximum)
		.refine((value) => new Set(value).size === value.length, "Duplicate IDs")
		.transform((value) => [...value].sort());
const token = z.string().regex(/^[a-f0-9]{64}$/);
export const apiTaskRelationshipSnapshotSchema = z
	.object({
		version: z.literal(1),
		taskId: id,
		listId: id,
		workspaceId: id,
		assigneeIds: z.array(id),
		labelIds: z.array(id),
	})
	.strict();
export const apiTaskRelationshipObservationSchema = z
	.object({ snapshot: apiTaskRelationshipSnapshotSchema, stateToken: token })
	.strict();
export const apiTaskRelationshipsSchema = z
	.object({
		workspaceId: id,
		listId: id,
		expectedState: token,
		assigneeIds: ids(20),
		labelIds: ids(50),
	})
	.strict();
export const apiTaskRelationshipsAckSchema = z
	.object({
		kind: z.literal("task-relationships-update-ack"),
		snapshot: apiTaskRelationshipSnapshotSchema,
	})
	.strict();
export type ApiTaskRelationships = z.infer<typeof apiTaskRelationshipsSchema>;
export type ApiTaskRelationshipSnapshot = z.infer<
	typeof apiTaskRelationshipSnapshotSchema
>;
function own(
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
	return (
		(prototype === null || prototype === Object.prototype) &&
		Object.entries(Object.getOwnPropertyDescriptors(value)).every(
			([key, d]) =>
				allowed.includes(key) &&
				d.enumerable &&
				"value" in d &&
				d.value !== undefined,
		)
	);
}
export function parseApiTaskRelationships(
	value: unknown,
): ApiTaskRelationships {
	if (
		!own(value, [
			"workspaceId",
			"listId",
			"expectedState",
			"assigneeIds",
			"labelIds",
		])
	)
		throw new PublicApiError(
			400,
			"invalid-task-relationships",
			"Invalid relationship fields",
		);
	const result = apiTaskRelationshipsSchema.safeParse(value);
	if (!result.success)
		throw new PublicApiError(
			400,
			"invalid-task-relationships",
			"Invalid relationship fields",
		);
	return result.data;
}
export function canonicalApiTaskRelationships(
	taskId: string,
	value: ApiTaskRelationships,
): string {
	return JSON.stringify({
		operation: "task.relationships.update.v1",
		taskId: id.parse(taskId),
		...parseApiTaskRelationships(value),
	});
}
export function canonicalApiTaskRelationshipSnapshot(
	value: ApiTaskRelationshipSnapshot,
): string {
	const snapshot = apiTaskRelationshipSnapshotSchema.parse(value);
	return JSON.stringify({
		...snapshot,
		assigneeIds: [...snapshot.assigneeIds].sort(),
		labelIds: [...snapshot.labelIds].sort(),
	});
}
export function taskRelationshipsAck(
	taskId: string,
	value: ApiTaskRelationships,
) {
	const input = parseApiTaskRelationships(value);
	return apiTaskRelationshipsAckSchema.parse({
		kind: "task-relationships-update-ack",
		snapshot: {
			version: 1,
			taskId,
			listId: input.listId,
			workspaceId: input.workspaceId,
			assigneeIds: input.assigneeIds,
			labelIds: input.labelIds,
		},
	});
}
