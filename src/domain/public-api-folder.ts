import { z } from "zod";
import { PUBLIC_API_ID, PublicApiError } from "./public-api.ts";
import {
	type ApiFolder,
	publicApiResourceSchemas,
} from "./public-api-resources.ts";

const validText = (value: string) =>
	!value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value);
const workspaceId = PUBLIC_API_ID.refine(validText);
const name = z.string().trim().min(1).max(500).refine(validText);
const token = z.string().regex(/^[a-f0-9]{64}$/);
export const apiFolderCreateSchema = z.object({ workspaceId, name }).strict();
export const apiFolderUpdateSchema = z
	.object({
		workspaceId,
		expectedState: token,
		patch: z.object({ name }).strict(),
	})
	.strict();
export const apiFolderDeleteSchema = z
	.object({ workspaceId, expectedState: token })
	.strict();
export const apiFolderObservationSchema = z
	.object({ snapshot: publicApiResourceSchemas.folders, stateToken: token })
	.strict();
export const apiFolderCreateAckSchema = z
	.object({
		kind: z.literal("folder-create-ack"),
		snapshot: publicApiResourceSchemas.folders,
	})
	.strict();
export const apiFolderUpdateAckSchema = z
	.object({
		kind: z.literal("folder-update-ack"),
		snapshot: publicApiResourceSchemas.folders,
	})
	.strict();
export const apiFolderDeleteAckSchema = z
	.object({
		kind: z.literal("folder-delete-ack"),
		snapshot: publicApiResourceSchemas.folders,
	})
	.strict();
export type ApiFolderCreate = z.infer<typeof apiFolderCreateSchema>;
export type ApiFolderUpdate = z.infer<typeof apiFolderUpdateSchema>;
export type ApiFolderDelete = z.infer<typeof apiFolderDeleteSchema>;
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
const invalid = () =>
	new PublicApiError(400, "invalid-folder", "Invalid folder fields");
export function parseApiFolderCreate(value: unknown): ApiFolderCreate {
	if (!ownFields(value, ["workspaceId", "name"])) throw invalid();
	const result = apiFolderCreateSchema.safeParse(value);
	if (!result.success) throw invalid();
	return result.data;
}
export function parseApiFolderUpdate(value: unknown): ApiFolderUpdate {
	if (
		!ownFields(value, ["workspaceId", "expectedState", "patch"]) ||
		!ownFields(value.patch, ["name"])
	)
		throw invalid();
	const result = apiFolderUpdateSchema.safeParse(value);
	if (!result.success) throw invalid();
	return result.data;
}
export function parseApiFolderDelete(value: unknown): ApiFolderDelete {
	if (!ownFields(value, ["workspaceId", "expectedState"])) throw invalid();
	const result = apiFolderDeleteSchema.safeParse(value);
	if (!result.success) throw invalid();
	return result.data;
}
export const canonicalApiFolderCreate = (value: ApiFolderCreate) =>
	JSON.stringify({
		operation: "folder.create.v1",
		...parseApiFolderCreate(value),
	});
export const canonicalApiFolderUpdate = (
	folderId: string,
	value: ApiFolderUpdate,
) =>
	JSON.stringify({
		operation: "folder.update.v1",
		folderId,
		...parseApiFolderUpdate(value),
	});
export const canonicalApiFolderDelete = (
	folderId: string,
	value: ApiFolderDelete,
) =>
	JSON.stringify({
		operation: "folder.delete.v1",
		folderId,
		...parseApiFolderDelete(value),
	});
export const canonicalApiFolderSnapshot = (snapshot: ApiFolder) =>
	JSON.stringify({
		version: 1,
		snapshot: publicApiResourceSchemas.folders.parse(snapshot),
	});
