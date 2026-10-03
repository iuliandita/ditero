import { z } from "zod";

export const PUBLIC_API_VERSION = 1;
export const PUBLIC_API_PAGE_SIZE = 50;
export const PUBLIC_API_MAX_PAGE_SIZE = 100;
export const PUBLIC_API_ID = z.string().min(1).max(256);
export const tokenCreateSchema = z
	.object({
		name: z
			.string()
			.trim()
			.min(1)
			.max(80)
			.refine(
				(value) =>
					!Array.from(value).some(
						(character) =>
							character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
					),
			),
		access: z.enum(["read", "write"]).default("read"),
		expiresInDays: z.number().int().min(1).max(365).default(90),
	})
	.strict();

export class PublicApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "PublicApiError";
	}
}

export function publicApiProblem(error: PublicApiError): Response {
	return Response.json(
		{
			type: `urn:ditero:api:error:${error.code}`,
			title: error.message,
			status: error.status,
			code: error.code,
		},
		{
			status: error.status,
			headers: {
				"content-type": "application/problem+json",
				"cache-control": "no-store",
				...(error.status === 401
					? { "www-authenticate": 'Bearer realm="ditero"' }
					: {}),
				...(error.status === 429 ? { "retry-after": "5" } : {}),
			},
		},
	);
}

export function apiResult(
	data: unknown,
	nextCursor: string | null = null,
	status = 200,
): Response {
	return Response.json(
		{ version: PUBLIC_API_VERSION, data, nextCursor },
		{
			status,
			headers: {
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
			},
		},
	);
}
