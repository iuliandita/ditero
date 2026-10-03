import { z } from "zod";
import { PUBLIC_API_ID, PublicApiError } from "./public-api.ts";

const uniqueIds = (maximum: number) =>
	z
		.array(PUBLIC_API_ID)
		.max(maximum)
		.refine((ids) => new Set(ids).size === ids.length, "Duplicate IDs")
		.transform((ids) => [...ids].sort())
		.default([]);

export const apiTaskCreateSchema = z
	.object({
		listId: PUBLIC_API_ID,
		title: z.string().trim().min(1).max(500),
		notes: z.string().max(32_768).nullable().default(null),
		dueAt: z.iso
			.datetime({ offset: true })
			.transform((value) => new Date(value).toISOString())
			.nullable()
			.default(null),
		dueAllDay: z.boolean().default(false),
		priority: z.number().int().min(0).max(3).default(0),
		assigneeIds: uniqueIds(20),
		labelIds: uniqueIds(50),
	})
	.strict()
	.refine(
		(value) => !value.dueAllDay || value.dueAt !== null,
		"All-day tasks require a due instant",
	);

export type ApiTaskCreate = z.infer<typeof apiTaskCreateSchema>;

export function parseApiTaskCreate(input: unknown): ApiTaskCreate {
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		Object.getOwnPropertySymbols(input).length ||
		Object.keys(input).some(
			(key) =>
				![
					"listId",
					"title",
					"notes",
					"dueAt",
					"dueAllDay",
					"priority",
					"assigneeIds",
					"labelIds",
				].includes(key),
		)
	)
		throw new PublicApiError(400, "invalid-task", "Invalid task fields");
	const result = apiTaskCreateSchema.safeParse(input);
	if (!result.success)
		throw new PublicApiError(400, "invalid-task", "Invalid task fields");
	return result.data;
}

export function parseApiIdempotencyKey(value: string | null): string {
	if (!value || !z.uuid().safeParse(value).success)
		throw new PublicApiError(
			400,
			"invalid-idempotency-key",
			"A UUID Idempotency-Key is required",
		);
	return value.toLowerCase();
}

export function canonicalApiTaskCreate(input: ApiTaskCreate): string {
	return JSON.stringify({
		operation: "task.create.v1",
		...parseApiTaskCreate(input),
	});
}
