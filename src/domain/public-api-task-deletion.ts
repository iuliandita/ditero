import { z } from "zod";
import { PUBLIC_API_ID, PublicApiError } from "./public-api.ts";
import { apiTaskSnapshotSchema } from "./public-api-task-update.ts";

const token = z.string().regex(/^[a-f0-9]{64}$/);
export const apiTaskChildrenStateSchema = z
	.object({
		version: z.literal(1),
		count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		token,
	})
	.strict();
export const apiTaskDeletionObservationSchema = z
	.object({
		snapshot: apiTaskSnapshotSchema,
		stateToken: token,
		childrenState: apiTaskChildrenStateSchema,
	})
	.strict();
export const apiTaskDeleteSchema = z
	.object({
		listId: PUBLIC_API_ID,
		expectedState: token,
		expectedChildrenState: apiTaskChildrenStateSchema,
		cascadeChildren: z.boolean(),
	})
	.strict();
export const apiTaskDeletedSchema = z
	.object({
		taskId: PUBLIC_API_ID,
		listId: PUBLIC_API_ID,
		deleted: z.literal(true),
		deletedChildren: z
			.number()
			.int()
			.nonnegative()
			.max(Number.MAX_SAFE_INTEGER),
	})
	.strict();
export type ApiTaskDelete = z.infer<typeof apiTaskDeleteSchema>;

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
export function parseApiTaskDelete(value: unknown): ApiTaskDelete {
	if (
		!ownFields(value, [
			"listId",
			"expectedState",
			"expectedChildrenState",
			"cascadeChildren",
		]) ||
		!ownFields(value.expectedChildrenState, ["version", "count", "token"])
	)
		throw new PublicApiError(
			400,
			"invalid-task",
			"Invalid task deletion fields",
		);
	const parsed = apiTaskDeleteSchema.safeParse(value);
	if (!parsed.success)
		throw new PublicApiError(
			400,
			"invalid-task",
			"Invalid task deletion fields",
		);
	return parsed.data;
}
export function canonicalApiTaskDelete(
	taskId: string,
	input: ApiTaskDelete,
): string {
	return JSON.stringify({
		operation: "task.delete.v1",
		taskId,
		...parseApiTaskDelete(input),
	});
}
