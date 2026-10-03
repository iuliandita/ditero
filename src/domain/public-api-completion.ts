import { z } from "zod";
import { PUBLIC_API_ID, PublicApiError } from "./public-api.ts";

export const apiTaskCompleteSchema = z
	.object({
		listId: PUBLIC_API_ID,
		expectedDueAt: z.iso
			.datetime({ offset: true })
			.transform((value) => new Date(value).toISOString())
			.nullable(),
	})
	.strict();

export type ApiTaskComplete = z.infer<typeof apiTaskCompleteSchema>;

export function parseApiTaskComplete(input: unknown): ApiTaskComplete {
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		Object.getOwnPropertySymbols(input).length ||
		Object.keys(input).some((key) => !["listId", "expectedDueAt"].includes(key))
	)
		throw new PublicApiError(
			400,
			"invalid-task",
			"Invalid task completion fields",
		);
	const result = apiTaskCompleteSchema.safeParse(input);
	if (!result.success)
		throw new PublicApiError(
			400,
			"invalid-task",
			"Invalid task completion fields",
		);
	return result.data;
}

export function canonicalApiTaskComplete(
	taskId: string,
	input: ApiTaskComplete,
): string {
	return JSON.stringify({
		operation: "task.complete.v1",
		taskId,
		...parseApiTaskComplete(input),
	});
}
