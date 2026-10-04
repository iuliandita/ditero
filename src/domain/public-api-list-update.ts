import { z } from "zod";
import { PUBLIC_API_ID, PublicApiError } from "./public-api.ts";
import {
	type ApiList,
	publicApiResourceSchemas,
} from "./public-api-resources.ts";

const validText = (value: string) =>
	!value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value);
const stateToken = z.string().regex(/^[a-f0-9]{64}$/);
export const apiListObservationSchema = z
	.object({
		snapshot: publicApiResourceSchemas.lists,
		stateToken,
	})
	.strict();
export const apiListUpdateAckSchema = z
	.object({
		kind: z.literal("list-update-ack"),
		snapshot: publicApiResourceSchemas.lists,
	})
	.strict();
export const apiListUpdateSchema = z
	.object({
		workspaceId: PUBLIC_API_ID.refine(validText),
		expectedState: stateToken,
		patch: z
			.object({
				title: z.string().trim().min(1).max(500).refine(validText).optional(),
				icon: z.string().max(128).refine(validText).nullable().optional(),
				completedDisplay: z.enum(["sink", "keep", "hide"]).optional(),
			})
			.strict()
			.refine(
				(value) => Object.values(value).some((field) => field !== undefined),
				"A metadata patch is required",
			),
	})
	.strict();
export type ApiListUpdate = z.infer<typeof apiListUpdateSchema>;

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
export function parseApiListUpdate(value: unknown): ApiListUpdate {
	if (
		!ownFields(value, ["workspaceId", "expectedState", "patch"]) ||
		!ownFields(value.patch, ["title", "icon", "completedDisplay"])
	)
		throw new PublicApiError(400, "invalid-list", "Invalid list update fields");
	const parsed = apiListUpdateSchema.safeParse(value);
	if (!parsed.success)
		throw new PublicApiError(400, "invalid-list", "Invalid list update fields");
	return parsed.data;
}
export function canonicalApiListUpdate(
	listId: string,
	value: ApiListUpdate,
): string {
	const input = parseApiListUpdate(value);
	return JSON.stringify({
		operation: "list.update.v1",
		listId,
		workspaceId: input.workspaceId,
		expectedState: input.expectedState,
		patch: input.patch,
	});
}
export function canonicalApiListSnapshot(value: ApiList): string {
	return JSON.stringify({
		version: 1,
		snapshot: publicApiResourceSchemas.lists.parse(value),
	});
}
