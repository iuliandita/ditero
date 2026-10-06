import { z } from "zod";
import {
	type AccountSetupStatus,
	accountSetupStatusResponseSchema,
} from "../domain/account-setup-status.ts";
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
	maximumBytes: number,
): Promise<Uint8Array> {
	const declared = response.headers.get("content-length");
	if (
		declared &&
		(/^\d+$/.test(declared) ? Number(declared) > maximumBytes : true)
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
			if (length > maximumBytes) {
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

interface Exchange {
	method: "GET" | "POST" | "PATCH" | "DELETE";
	headers: Record<string, string>;
	body?: string;
	created: boolean;
	failure: (status: number) => CliError;
}

export async function requestJson(
	options: CliOptions,
	url: URL,
	fetcher: Fetcher = fetch,
	write?: {
		body: string;
		requestId: string;
		method?: "POST" | "PATCH" | "DELETE";
		allowCreated?: boolean;
	},
	budget: ResponseBudget = { bytes: 0 },
	callerSignal?: AbortSignal,
	maximumResponseBytes = MAX_RESPONSE_BYTES,
): Promise<unknown> {
	const method = write ? (write.method ?? "POST") : "GET";
	return exchange(
		options,
		url,
		fetcher,
		{
			method,
			headers: write
				? {
						"content-type": "application/json",
						"idempotency-key": write.requestId,
					}
				: {},
			body: write?.body,
			created: !!write && method === "POST" && write.allowCreated !== false,
			failure: httpError,
		},
		budget,
		callerSignal,
		maximumResponseBytes,
	);
}

function webhookFailure(command: CliOptions["command"], status: number) {
	if (status === 409 && command === "create-webhook")
		return new CliError(
			"webhook_limit",
			"The webhook limit was reached. Revoke an unused webhook first.",
			10,
			status,
		);
	if (status === 503)
		return new CliError(
			"temporarily_unavailable",
			command === "create-webhook"
				? "The server is temporarily unavailable. List webhooks before retrying creation."
				: "The server is temporarily unavailable. Try again later.",
			9,
			status,
		);
	return status === 409 || status === 410
		? new CliError(
				"http_error",
				"The server could not complete the request.",
				9,
				status,
			)
		: httpError(status);
}

// Once a create POST is sent it may have committed with its one-time secret
// lost. Definite HTTP status errors keep their own mapping; every other
// post-send failure carries the same fixed recovery advice.
const CREATE_UNCERTAIN_CODES = new Set([
	"network_error",
	"cancelled",
	"invalid_response",
]);
const CREATE_UNCERTAIN_ADVICE =
	"The webhook may have been created and its secret was not received. List webhooks and revoke any unexpected one before retrying.";

// Webhook management carries no request ID: creation is never replayed and
// revocation is naturally idempotent, so no idempotency header is sent.
export async function requestWebhookJson(
	options: CliOptions,
	url: URL,
	fetcher: Fetcher = fetch,
	request: { method: "GET" | "POST" | "DELETE"; body?: string },
	callerSignal?: AbortSignal,
): Promise<unknown> {
	// Nothing is sent when cancelled up front, so there is no uncertainty.
	if (callerSignal?.aborted) cancelled();
	try {
		return await exchange(
			options,
			url,
			fetcher,
			{
				method: request.method,
				headers:
					request.body === undefined
						? {}
						: { "content-type": "application/json" },
				body: request.body,
				created: request.method === "POST",
				failure: (status) => webhookFailure(options.command, status),
			},
			{ bytes: 0 },
			callerSignal,
			MAX_RESPONSE_BYTES,
		);
	} catch (error) {
		if (
			options.command === "create-webhook" &&
			error instanceof CliError &&
			(CREATE_UNCERTAIN_CODES.has(error.code) ||
				(error.status !== null && error.status >= 500))
		)
			throw new CliError(
				error.code,
				`${error.message} ${CREATE_UNCERTAIN_ADVICE}`,
				error.exitCode,
				error.status,
			);
		throw error;
	}
}

async function exchange(
	options: CliOptions,
	url: URL,
	fetcher: Fetcher,
	request: Exchange,
	budget: ResponseBudget,
	callerSignal: AbortSignal | undefined,
	maximumResponseBytes: number,
): Promise<unknown> {
	if (callerSignal?.aborted) cancelled();
	const signal = AbortSignal.any([
		AbortSignal.timeout(15_000),
		...(callerSignal ? [callerSignal] : []),
	]);
	let response: Response;
	try {
		response = await fetcher(url, {
			method: request.method,
			redirect: "error",
			credentials: "omit",
			headers: {
				authorization: `Bearer ${options.token}`,
				accept: "application/json",
				...request.headers,
			},
			signal,
			...(request.body === undefined ? {} : { body: request.body }),
		});
	} catch {
		if (callerSignal?.aborted) cancelled();
		throw new CliError(
			"network_error",
			"Could not reach the server within the request timeout.",
			7,
		);
	}
	if (
		response.status !== 200 &&
		!(request.created && response.status === 201)
	) {
		await response.body?.cancel();
		throw request.failure(response.status);
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
		bytes = await readBody(
			response,
			signal,
			() => {
				if (callerSignal?.aborted) cancelled();
				throw new CliError(
					"network_error",
					"The server response could not be read.",
					7,
				);
			},
			maximumResponseBytes,
		);
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
	if (options.command === "setup-status") {
		const status = await readSetupStatus(options, fetcher, callerSignal);
		return { version: 1, data: status, nextCursor: null };
	}
	if (
		options.command === "list-task-comments" ||
		options.command === "observe-comment" ||
		options.command === "add-comment" ||
		options.command === "edit-comment" ||
		options.command === "delete-comment" ||
		options.command === "observe-folder" ||
		options.command === "create-folder" ||
		options.command === "update-folder" ||
		options.command === "delete-folder" ||
		options.command === "create-list" ||
		options.command === "observe-list" ||
		options.command === "observe-list-deletion" ||
		options.command === "delete-list" ||
		options.command === "update-list" ||
		options.command === "plan-task" ||
		options.command === "create-task" ||
		options.command === "complete-task" ||
		options.command === "observe-task" ||
		options.command === "observe-task-deletion" ||
		options.command === "observe-task-placement" ||
		options.command === "place-task" ||
		options.command === "observe-task-relationships" ||
		options.command === "update-task-relationships" ||
		options.command === "update-task" ||
		options.command === "delete-task" ||
		options.command === "list-webhooks" ||
		options.command === "create-webhook" ||
		options.command === "revoke-webhook"
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

// A missing endpoint is an absent optional capability, not pending setup.
export async function readSetupStatus(
	options: CliOptions,
	fetcher: Fetcher = fetch,
	signal?: AbortSignal,
): Promise<AccountSetupStatus | null> {
	const bounded = signal
		? AbortSignal.any([signal, AbortSignal.timeout(1500)])
		: AbortSignal.timeout(1500);
	try {
		const raw = await requestJson(
			options,
			new URL("/api/v1/setup-status", options.server),
			fetcher,
			undefined,
			{ bytes: 0 },
			bounded,
			16 * 1024,
		);
		const parsed = accountSetupStatusResponseSchema.safeParse(raw);
		if (!parsed.success) return invalidResponse();
		return parsed.data.data;
	} catch (error) {
		if (error instanceof CliError && error.status === 404) return null;
		throw error;
	}
}
export function setupNoticeURL(
	status: AccountSetupStatus | null,
	server: string,
): string | null {
	return status?.outcome === "pending" && status.eligibility === "available"
		? new URL("/setup", server).href
		: null;
}
