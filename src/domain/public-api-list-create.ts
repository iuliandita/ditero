import { z } from "zod";
import { PUBLIC_API_ID, PublicApiError } from "./public-api.ts";
import { publicApiResourceSchemas } from "./public-api-resources.ts";

const validText = (value: string) =>
	!value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value);

export const apiListCreateSchema = z
	.object({
		workspaceId: PUBLIC_API_ID.refine(validText),
		title: z.string().trim().min(1).max(500).refine(validText),
		kind: z.enum(["tasks", "shopping", "checklist", "project", "habits"]),
		icon: z.string().max(128).refine(validText).nullable().default(null),
	})
	.strict();

export type ApiListCreate = z.infer<typeof apiListCreateSchema>;

export const apiListCreationAckSchema = z
	.object({
		kind: z.literal("list-create-ack"),
		snapshot: publicApiResourceSchemas.lists,
	})
	.strict();

export type ApiListCreationAck = z.infer<typeof apiListCreationAckSchema>;

export function parseApiListCreate(input: unknown): ApiListCreate {
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		Object.getOwnPropertySymbols(input).length ||
		Object.keys(input).some(
			(key) => !["workspaceId", "title", "kind", "icon"].includes(key),
		)
	)
		throw new PublicApiError(400, "invalid-list", "Invalid list fields");
	const result = apiListCreateSchema.safeParse(input);
	if (!result.success)
		throw new PublicApiError(400, "invalid-list", "Invalid list fields");
	return result.data;
}

export function canonicalApiListCreate(input: ApiListCreate): string {
	const parsed = parseApiListCreate(input);
	return JSON.stringify({
		operation: "list.create.v1",
		workspaceId: parsed.workspaceId,
		title: parsed.title,
		kind: parsed.kind,
		icon: parsed.icon,
	});
}
