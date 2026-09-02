import { z } from "zod";
import type { E2eFetcher } from "./workspace-keys.ts";

const defaultFetcher: E2eFetcher = (input, init) => fetch(input, init);

const configSchema = z.object({
	maxFileBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

const grantSchema = z.object({
	requestId: z.string(),
	workspaceId: z.string(),
	keyVersion: z.number().int().positive(),
	state: z.enum(["pending", "unrecoverable", "failed", "ready"]),
	failureReason: z.string().nullable(),
	holders: z.array(z.object({ userId: z.string(), name: z.string() })),
});

const grantsSchema = z.object({ requests: z.array(grantSchema) });
const deleteSchema = z.object({
	id: z.string(),
	state: z.literal("deleting"),
});

export type MyAttachmentGrant = z.infer<typeof grantSchema>;

async function json<T>(
	path: string,
	schema: z.ZodType<T>,
	fetcher: E2eFetcher,
	init?: RequestInit,
): Promise<T> {
	const response = await fetcher(path, {
		credentials: "include",
		...init,
	});
	if (!response.ok) {
		throw new Error(`attachment API: ${path} failed (${response.status})`);
	}
	return schema.parse(await response.json());
}

export function fetchAttachmentConfig(
	fetcher: E2eFetcher = defaultFetcher,
): Promise<{ maxFileBytes: number }> {
	return json("/api/attachments/config", configSchema, fetcher);
}

export async function fetchMyGrants(
	fetcher: E2eFetcher = defaultFetcher,
): Promise<MyAttachmentGrant[]> {
	return (await json("/api/e2e/grants/mine", grantsSchema, fetcher)).requests;
}

export function deleteAttachment(
	id: string,
	fetcher: E2eFetcher = defaultFetcher,
): Promise<{ id: string; state: "deleting" }> {
	return json("/api/attachments/delete", deleteSchema, fetcher, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id }),
	});
}
