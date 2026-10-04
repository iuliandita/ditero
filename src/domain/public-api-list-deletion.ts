import { z } from "zod";
import { PUBLIC_API_ID, PublicApiError } from "./public-api.ts";
import { publicApiResourceSchemas } from "./public-api-resources.ts";

const token = z.string().regex(/^[a-f0-9]{64}$/);
export const apiListTasksStateSchema = z
	.object({
		version: z.literal(1),
		count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		token,
	})
	.strict();
export const apiListDeletionObservationSchema = z
	.object({
		snapshot: publicApiResourceSchemas.lists,
		stateToken: token,
		tasksState: apiListTasksStateSchema,
	})
	.strict();
export const apiListDeleteSchema = z
	.object({
		workspaceId: PUBLIC_API_ID.refine(
			(value) => !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value),
		),
		expectedState: token,
		expectedTasksState: apiListTasksStateSchema,
		cascadeTasks: z.boolean(),
	})
	.strict();
export const apiListDeleteAckSchema = z
	.object({
		kind: z.literal("list-delete-ack"),
		snapshot: publicApiResourceSchemas.lists,
		deletedTasks: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	})
	.strict();
export type ApiListDelete = z.infer<typeof apiListDeleteSchema>;

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
export function parseApiListDelete(value: unknown): ApiListDelete {
	if (
		!ownFields(value, [
			"workspaceId",
			"expectedState",
			"expectedTasksState",
			"cascadeTasks",
		]) ||
		!ownFields(value.expectedTasksState, ["version", "count", "token"])
	)
		throw new PublicApiError(
			400,
			"invalid-list",
			"Invalid list deletion fields",
		);
	const parsed = apiListDeleteSchema.safeParse(value);
	if (!parsed.success)
		throw new PublicApiError(
			400,
			"invalid-list",
			"Invalid list deletion fields",
		);
	return parsed.data;
}
export function canonicalApiListDelete(
	listId: string,
	input: ApiListDelete,
): string {
	return JSON.stringify({
		operation: "list.delete.v1",
		listId,
		...parseApiListDelete(input),
	});
}
