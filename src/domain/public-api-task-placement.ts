import { generateKeyBetween } from "fractional-indexing";
import { z } from "zod";
import { PUBLIC_API_ID, PublicApiError } from "./public-api.ts";
import { publicApiResourceSchemas } from "./public-api-resources.ts";
import { apiTaskChildrenStateSchema } from "./public-api-task-deletion.ts";
import {
	apiTaskSnapshotSchema,
	canonicalApiTaskSnapshot,
} from "./public-api-task-update.ts";

const id = PUBLIC_API_ID.refine(
	(value) => !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value),
);
const token = z.string().regex(/^[a-f0-9]{64}$/);
export const placementSortKeySchema = z
	.string()
	.min(2)
	.max(256)
	.regex(/^[A-Za-z][A-Za-z0-9]+$/)
	.refine((value) => {
		try {
			generateKeyBetween(value, null);
			return true;
		} catch {
			return false;
		}
	});
export const apiTaskPlacementSnapshotSchema = z
	.object({
		version: z.literal(1),
		task: apiTaskSnapshotSchema,
		sortKey: z.string().max(256),
		parentId: PUBLIC_API_ID.nullable(),
		list: publicApiResourceSchemas.lists,
	})
	.strict()
	.refine(
		(value) =>
			value.task.listId === value.list.id &&
			value.task.workspaceId === value.list.workspaceId &&
			value.task.listKind === value.list.kind,
	);
export const apiTaskPlacementObservationSchema = z
	.object({
		snapshot: apiTaskPlacementSnapshotSchema,
		stateToken: token,
		childrenState: apiTaskChildrenStateSchema,
	})
	.strict();
export const apiTaskPlacementSchema = z
	.object({
		workspaceId: id,
		listId: id,
		expectedState: token,
		targetListId: id,
		expectedTargetState: token,
		sortKey: placementSortKeySchema,
		cascadeChildren: z.boolean(),
		expectedChildrenState: apiTaskChildrenStateSchema.nullable(),
	})
	.strict()
	.refine((value) =>
		value.targetListId === value.listId
			? !value.cascadeChildren && value.expectedChildrenState === null
			: value.cascadeChildren && value.expectedChildrenState !== null,
	);
export type ApiTaskPlacement = z.infer<typeof apiTaskPlacementSchema>;
export const apiTaskPlacementAckSchema = z
	.object({
		kind: z.literal("task-place-ack"),
		originalWorkspaceId: PUBLIC_API_ID,
		originalListId: PUBLIC_API_ID,
		movedChildren: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		snapshot: apiTaskPlacementSnapshotSchema,
	})
	.strict()
	.refine(
		(value) => value.originalWorkspaceId === value.snapshot.task.workspaceId,
	);

function own(
	value: unknown,
	keys: readonly string[],
): value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getOwnPropertySymbols(value).length
	)
		return false;
	if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
		return false;
	return Object.entries(Object.getOwnPropertyDescriptors(value)).every(
		([key, descriptor]) =>
			keys.includes(key) &&
			descriptor.enumerable &&
			"value" in descriptor &&
			descriptor.value !== undefined,
	);
}
export function parseApiTaskPlacement(value: unknown): ApiTaskPlacement {
	if (
		!own(value, [
			"workspaceId",
			"listId",
			"expectedState",
			"targetListId",
			"expectedTargetState",
			"sortKey",
			"cascadeChildren",
			"expectedChildrenState",
		]) ||
		(value.expectedChildrenState !== null &&
			!own(value.expectedChildrenState, ["version", "count", "token"]))
	)
		throw new PublicApiError(
			400,
			"invalid-task",
			"Invalid task placement fields",
		);
	const parsed = apiTaskPlacementSchema.safeParse(value);
	if (!parsed.success)
		throw new PublicApiError(
			400,
			"invalid-task",
			"Invalid task placement fields",
		);
	return parsed.data;
}
export function canonicalApiTaskPlacement(
	taskId: string,
	value: ApiTaskPlacement,
): string {
	return JSON.stringify({
		operation: "task.place.v1",
		taskId,
		...parseApiTaskPlacement(value),
	});
}
export function canonicalApiTaskPlacementSnapshot(
	value: z.infer<typeof apiTaskPlacementSnapshotSchema>,
): string {
	const parsed = apiTaskPlacementSnapshotSchema.parse(value);
	return JSON.stringify({
		...parsed,
		task: JSON.parse(canonicalApiTaskSnapshot(parsed.task)),
	});
}
