import { z } from "zod";
import { PUBLIC_API_VERSION } from "../domain/public-api.ts";
import {
	publicApiProfileSchema,
	publicApiResourceSchemas,
} from "../domain/public-api-resources.ts";
import { CliError, type CliOptions } from "./arguments.ts";

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_PAGES = 100;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const envelope = z
	.object({
		version: z.literal(PUBLIC_API_VERSION),
		data: z.unknown(),
		nextCursor: z
			.string()
			.regex(/^[A-Za-z0-9_-]{1,2048}$/)
			.nullable(),
	})
	.strict();
export interface CliResult {
	version: 1;
	data: unknown;
	nextCursor: string | null;
}
export type Fetcher = (input: URL, init: RequestInit) => Promise<Response>;

function invalidResponse(): never {
	throw new CliError(
		"invalid_response",
		"The server returned an invalid or oversized response.",
		8,
	);
}

function assertSafeJson(value: unknown, depth = 0): void {
	if (depth > 32) invalidResponse();
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		if (["__proto__", "constructor", "prototype"].includes(key))
			invalidResponse();
		assertSafeJson(child, depth + 1);
	}
}

function cancelled(): never {
	throw new CliError("cancelled", "The request was cancelled.", 7);
}

async function readBody(
	response: Response,
	signal: AbortSignal,
	abortFailure: () => never,
): Promise<Uint8Array> {
	const declared = response.headers.get("content-length");
	if (
		declared &&
		(/^\d+$/.test(declared) ? Number(declared) > MAX_RESPONSE_BYTES : true)
	) {
		await response.body?.cancel();
		invalidResponse();
	}
	if (!response.body) invalidResponse();
	const reader = response.body.getReader();
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			if (signal.aborted) abortFailure();
			const chunk = await reader.read();
			if (signal.aborted) abortFailure();
			if (chunk.done) break;
			length += chunk.value.byteLength;
			if (length > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				invalidResponse();
			}
			chunks.push(chunk.value);
		}
	} finally {
		signal.removeEventListener("abort", abort);
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function httpError(status: number): CliError {
	const known: Record<number, [string, string, number]> = {
		400: ["request_rejected", "The server rejected the request.", 2],
		401: ["unauthorized", "The token is invalid, expired, or revoked.", 3],
		403: ["forbidden", "The token cannot access this resource.", 4],
		404: ["not_found", "The requested resource or API was not found.", 5],
		409: [
			"request_conflict",
			"The request conflicts with the current task state or an existing request ID.",
			10,
		],
		410: [
			"task_deleted",
			"The task for this request ID was deleted. It will not be recreated.",
			11,
		],
		429: [
			"rate_limited",
			"The server rate limit was reached. Try again later.",
			6,
		],
	};
	const [code, message, exit] = known[status] ?? [
		"http_error",
		"The server could not complete the request.",
		9,
	];
	return new CliError(code, message, exit, status);
}

export interface ResponseBudget {
	bytes: number;
}

export async function requestJson(
	options: CliOptions,
	url: URL,
	fetcher: Fetcher = fetch,
	write?: { body: string; requestId: string },
	budget: ResponseBudget = { bytes: 0 },
	callerSignal?: AbortSignal,
): Promise<unknown> {
	if (callerSignal?.aborted) cancelled();
	const signal = AbortSignal.any([
		AbortSignal.timeout(15_000),
		...(callerSignal ? [callerSignal] : []),
	]);
	let response: Response;
	try {
		response = await fetcher(url, {
			method: write ? "POST" : "GET",
			redirect: "error",
			credentials: "omit",
			headers: {
				authorization: `Bearer ${options.token}`,
				accept: "application/json",
				...(write
					? {
							"content-type": "application/json",
							"idempotency-key": write.requestId,
						}
					: {}),
			},
			signal,
			...(write ? { body: write.body } : {}),
		});
	} catch {
		if (callerSignal?.aborted) cancelled();
		throw new CliError(
			"network_error",
			"Could not reach the server within the request timeout.",
			7,
		);
	}
	if (response.status !== 200 && !(write && response.status === 201)) {
		await response.body?.cancel();
		throw httpError(response.status);
	}
	if (
		response.redirected ||
		response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
			"application/json"
	) {
		await response.body?.cancel();
		invalidResponse();
	}
	let bytes: Uint8Array;
	try {
		bytes = await readBody(response, signal, () => {
			if (callerSignal?.aborted) cancelled();
			throw new CliError(
				"network_error",
				"The server response could not be read.",
				7,
			);
		});
	} catch (error) {
		if (error instanceof CliError) throw error;
		throw new CliError(
			"network_error",
			"The server response could not be read.",
			7,
		);
	}
	budget.bytes += bytes.length;
	if (budget.bytes > MAX_TOTAL_BYTES) invalidResponse();
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		invalidResponse();
	}
	assertSafeJson(raw);
	return raw;
}

export async function discover(
	options: CliOptions,
	fetcher: Fetcher = fetch,
	budget: ResponseBudget = { bytes: 0 },
	callerSignal?: AbortSignal,
): Promise<CliResult> {
	if (
		options.command === "plan-task" ||
		options.command === "create-task" ||
		options.command === "complete-task"
	)
		throw new CliError(
			"invalid_arguments",
			"Discovery requires a read command.",
			2,
		);
	const results: unknown[] = [];
	const seen = new Set<string>();
	let cursor = options.cursor;
	if (cursor) seen.add(cursor);
	for (let page = 0; page < MAX_PAGES; page++) {
		const url = new URL(
			`/api/v1/${options.command === "profile" ? "me" : options.command}`,
			options.server,
		);
		if (options.command !== "profile") {
			url.searchParams.set("limit", String(options.limit));
			if (cursor) url.searchParams.set("cursor", cursor);
			if (options.workspaceId)
				url.searchParams.set("workspaceId", options.workspaceId);
			if (options.listId) url.searchParams.set("listId", options.listId);
			if (options.done !== undefined)
				url.searchParams.set("done", options.done);
		}
		const raw = await requestJson(
			options,
			url,
			fetcher,
			undefined,
			budget,
			callerSignal,
		);
		const parsed = envelope.safeParse(raw);
		if (!parsed.success) invalidResponse();
		if (options.command === "profile") {
			const profile = publicApiProfileSchema.safeParse(parsed.data.data);
			if (!profile.success || parsed.data.nextCursor !== null)
				invalidResponse();
			return { version: 1, data: profile.data, nextCursor: null };
		}
		const data = z
			.array(publicApiResourceSchemas[options.command])
			.max(options.limit)
			.safeParse(parsed.data.data);
		if (!data.success) invalidResponse();
		if (!options.all)
			return {
				version: 1,
				data: data.data,
				nextCursor: parsed.data.nextCursor,
			};
		results.push(...data.data);
		if (parsed.data.nextCursor === null)
			return { version: 1, data: results, nextCursor: null };
		if (seen.has(parsed.data.nextCursor)) invalidResponse();
		seen.add(parsed.data.nextCursor);
		cursor = parsed.data.nextCursor;
	}
	throw new CliError(
		"pagination_limit",
		"The page limit was reached. Use explicit cursors for larger collections.",
		8,
	);
}
