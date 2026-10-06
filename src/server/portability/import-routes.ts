import { Elysia } from "elysia";
import type { Pool } from "pg";
import { z } from "zod";
import { UserContextError } from "../../db/user-context.ts";
import {
	parseImportDocument,
	UnsupportedImportVersionError,
} from "../../domain/portability/import-document.ts";
import {
	type ImportMappings,
	ImportPlanError,
} from "../../domain/portability/import-plan.ts";
import { ProviderImportError } from "../../domain/portability/providers/common.ts";
import {
	PROVIDER_REQUEST_MAX_BYTES,
	ProviderInputError,
	prepareProviderImportRequest,
} from "../../domain/portability/providers/input.ts";
import { PortableExportValidationError } from "../../domain/portability/validate.ts";
import type { Guards } from "../guards.ts";
import { getAttachmentMigrationParents } from "./attachment-migration-parents.ts";
import {
	attachmentMigrationReservationBodySchema,
	getAttachmentMigrationStatus,
	reserveAttachmentMigration,
} from "./attachment-migration-store.ts";
import { V4ApplyConflict } from "./import-activation.ts";
import { importActivationRoutes } from "./import-activation-routes.ts";
import { applyImportBatch, getImportRunStatus } from "./import-apply-store.ts";
import {
	discardImportPlan,
	discardImportSource,
	getImportPlanStatus,
	ImportPlanStoreError,
	listImportSources,
	saveImportPlan,
} from "./import-plan-store.ts";

const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_MAPPING_BYTES = 2 * 1024 * 1024;
// JSON-encoding an already serialized document can double its size.
const MAX_REQUEST_BYTES = 2 * MAX_DOCUMENT_BYTES + MAX_MAPPING_BYTES + 1024;
const BODY_TIMEOUT_MS = 30_000;
const headers = {
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
};
const sourceSchema = z.discriminatedUnion("mode", [
	z.strictObject({
		mode: z.literal("new"),
		id: z.uuid(),
		label: z.string().trim().min(1).max(100),
	}),
	z.strictObject({ mode: z.literal("existing"), id: z.uuid() }),
]);
const confirmationSchema = z.strictObject({
	planDigest: z.string().regex(/^[a-f0-9]{64}$/),
	counts: z.strictObject({
		ensure: z.number().int().min(0).max(50_000),
		ignored: z.number().int().min(0).max(50_000),
		blocked: z.number().int().min(0).max(50_000),
	}),
});

class ImportRequestError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
	) {
		super(code);
	}
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourceKey(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 4096 &&
		!value.includes("\u0000") &&
		value.isWellFormed()
	);
}

function text(value: unknown): value is string {
	return sourceKey(value) && value.length > 0;
}

function mappings(value: unknown): ImportMappings {
	if (
		!object(value) ||
		Object.keys(value).length !== 2 ||
		!object(value.workspaces) ||
		!object(value.principals)
	)
		throw new ImportRequestError("invalid-mappings", 400);
	const workspaces = Object.entries(value.workspaces);
	const principals = Object.entries(value.principals);
	if (workspaces.length + principals.length > 50_000)
		throw new ImportRequestError("mapping-limit", 413);
	if (
		workspaces.some(([key, target]) => !sourceKey(key) || !text(target)) ||
		principals.some(
			([key, target]) => !sourceKey(key) || (target !== null && !text(target)),
		)
	)
		throw new ImportRequestError("invalid-mappings", 400);
	if (Buffer.byteLength(JSON.stringify(value)) > MAX_MAPPING_BYTES)
		throw new ImportRequestError("mapping-limit", 413);
	// fromEntries treats source IDs such as __proto__ as ordinary own keys.
	return {
		workspaces: Object.fromEntries(workspaces) as Record<string, string>,
		principals: Object.fromEntries(principals) as Record<string, string | null>,
	};
}

async function readRequest(
	request: Request,
	maxBytes = MAX_REQUEST_BYTES,
	timeoutMs = BODY_TIMEOUT_MS,
): Promise<{ text: string; bytes: number }> {
	const declared = request.headers.get("content-length");
	if (
		declared !== null &&
		(!/^\d+$/.test(declared) ||
			!Number.isSafeInteger(Number(declared)) ||
			Number(declared) > maxBytes)
	)
		throw new ImportRequestError("request-limit", 413);
	if (!request.body) throw new ImportRequestError("invalid-request", 400);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let current = new Uint8Array(64 * 1024);
	let used = 0;
	let total = 0;
	let reads = 0;
	let stopped: ImportRequestError | null = null;
	const stop = (error: ImportRequestError) => {
		stopped ??= error;
		void reader.cancel().catch(() => {});
	};
	const abort = () => stop(new ImportRequestError("request-cancelled", 408));
	const timer = setTimeout(
		() => stop(new ImportRequestError("request-timeout", 408)),
		timeoutMs,
	);
	request.signal.addEventListener("abort", abort, { once: true });
	if (request.signal.aborted) abort();
	try {
		while (!stopped) {
			const { done, value } = await reader.read();
			if (done) break;
			if (++reads > 65_536) {
				stop(new ImportRequestError("request-limit", 413));
				break;
			}
			total += value.byteLength;
			if (total > maxBytes) {
				stop(new ImportRequestError("request-limit", 413));
				break;
			}
			for (let offset = 0; offset < value.byteLength; ) {
				const count = Math.min(
					current.length - used,
					value.byteLength - offset,
				);
				current.set(value.subarray(offset, offset + count), used);
				used += count;
				offset += count;
				if (used === current.length) {
					chunks.push(current);
					current = new Uint8Array(64 * 1024);
					used = 0;
				}
			}
		}
		if (stopped) throw stopped;
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const parts = chunks.map((chunk) =>
			decoder.decode(chunk, { stream: true }),
		);
		parts.push(
			decoder.decode(current.subarray(0, used), { stream: true }),
			decoder.decode(),
		);
		return { text: parts.join(""), bytes: total };
	} finally {
		clearTimeout(timer);
		request.signal.removeEventListener("abort", abort);
		reader.releaseLock();
	}
}

function response(body: unknown, status = 200) {
	return Response.json(body, { status, headers });
}

async function handled(run: () => Promise<Response>): Promise<Response> {
	try {
		return await run();
	} catch (error) {
		if (
			error instanceof ImportRequestError ||
			error instanceof ImportPlanStoreError
		)
			return response({ code: error.code }, error.status);
		if (error instanceof V4ApplyConflict)
			return response({ code: error.code }, 409);
		if (error instanceof UserContextError)
			return response({ code: "unauthorized" }, 401);
		if (error instanceof UnsupportedImportVersionError)
			return response({ code: error.code }, 400);
		if (error instanceof PortableExportValidationError)
			return response(
				{ code: error.code },
				error.code.endsWith("-limit") ? 413 : 400,
			);
		if (
			error instanceof ProviderInputError ||
			error instanceof ProviderImportError
		)
			return response(
				{ code: error.code },
				error.code.endsWith("-limit")
					? 413
					: error.code === "cancelled"
						? 408
						: error.code === "timeout"
							? 503
							: 400,
			);
		if (error instanceof ImportPlanError)
			return response({ code: error.code }, 400);
		console.error("import plan request failed", { category: "unexpected" });
		return response({ code: "import-plan-failed" }, 500);
	}
}

function pathId(request: Request, discard = false): string {
	const parts = new URL(request.url).pathname.split("/");
	const id = parts.at(discard ? -2 : -1) ?? "";
	if (!/^[a-zA-Z0-9-]{1,128}$/.test(id))
		throw new ImportRequestError("not-found", 404);
	return id;
}

function parentDiscoveryQuery(request: Request): {
	afterOrdinal: number;
	limit: number;
} {
	const result = { afterOrdinal: -1, limit: 64 };
	const seen = new Set<string>();
	for (const [key, raw] of new URL(request.url).searchParams) {
		if (
			(key !== "afterOrdinal" && key !== "limit") ||
			seen.has(key) ||
			!/^[-]?\d+$/.test(raw)
		)
			throw new ImportRequestError("invalid-parent-discovery", 400);
		seen.add(key);
		const value = Number(raw);
		const minimum = key === "afterOrdinal" ? -1 : 1;
		const maximum = key === "afterOrdinal" ? 50_000 : 64;
		if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
			throw new ImportRequestError("invalid-parent-discovery", 400);
		result[key] = value;
	}
	return result;
}

function reservationJobId(request: Request): string {
	const id = pathId(request, true);
	if (!/^[a-f0-9]{64}$/.test(id))
		throw new ImportRequestError("not-found", 404);
	return id;
}

function reservationOrdinal(request: Request): number {
	const entries = [...new URL(request.url).searchParams];
	if (
		entries.length !== 1 ||
		entries[0]?.[0] !== "ordinal" ||
		!/^(0|[1-9][0-9]*)$/.test(entries[0][1])
	)
		throw new ImportRequestError("invalid-migration-status", 400);
	const ordinal = Number(entries[0][1]);
	if (!Number.isSafeInteger(ordinal) || ordinal > 50000)
		throw new ImportRequestError("invalid-migration-status", 400);
	return ordinal;
}

export function importPlanRoutes(pool: Pool, guards: Guards) {
	const activeUsers = new Set<string>();
	return new Elysia()
		.use(importActivationRoutes(pool, guards))
		.get(
			"/api/portability/import/plans/:id/attachment-reservations",
			guards.guardedGet((request, session) =>
				handled(async () => {
					const ordinal = reservationOrdinal(request);
					return response(
						await getAttachmentMigrationStatus(
							pool,
							session.user.id,
							reservationJobId(request),
							ordinal,
							{ signal: request.signal },
						),
					);
				}),
			),
		)
		.post(
			"/api/portability/import/plans/:id/attachment-reservations",
			guards.guardedPost((request, session) =>
				handled(async () => {
					if (activeUsers.size >= 2 || activeUsers.has(session.user.id))
						return Response.json(
							{ code: "import-busy" },
							{ status: 429, headers: { ...headers, "retry-after": "5" } },
						);
					activeUsers.add(session.user.id);
					try {
						if (
							(request.headers.get("content-type") ?? "")
								.split(";")[0]
								?.trim()
								.toLowerCase() !== "application/json"
						)
							throw new ImportRequestError("invalid-request", 415);
						let raw: unknown;
						try {
							raw = JSON.parse(
								(await readRequest(request, 256 * 1024, 5000)).text,
							);
						} catch (error) {
							if (error instanceof ImportRequestError) throw error;
							throw new ImportRequestError("invalid-request", 400);
						}
						const parsed =
							attachmentMigrationReservationBodySchema.safeParse(raw);
						if (!parsed.success)
							throw new ImportRequestError(
								"invalid-migration-reservation",
								400,
							);
						if (request.signal.aborted)
							throw new ImportRequestError("request-cancelled", 408);
						return response(
							await reserveAttachmentMigration(
								pool,
								{
									...parsed.data,
									ownerId: session.user.id,
									jobId: reservationJobId(request),
								},
								{ signal: request.signal },
							),
						);
					} finally {
						activeUsers.delete(session.user.id);
					}
				}),
			),
			{ parse: "none" },
		)
		.get(
			"/api/portability/import/plans/:id/attachment-parents",
			guards.guardedGet((request, session) =>
				handled(async () => {
					const pagination = parentDiscoveryQuery(request);
					return response(
						await getAttachmentMigrationParents(
							pool,
							session.user.id,
							pathId(request, true),
							{ ...pagination, signal: request.signal },
						),
					);
				}),
			),
		)
		.get(
			"/api/portability/import/plans/:id/run",
			guards.guardedGet((request, session) =>
				handled(async () => {
					const result = await getImportRunStatus(
						pool,
						session.user.id,
						pathId(request, true),
					);
					return response({ run: result });
				}),
			),
		)
		.post(
			"/api/portability/import/plans/:id/apply",
			guards.guardedPost((request, session) =>
				handled(async () => {
					if (activeUsers.size >= 2 || activeUsers.has(session.user.id))
						return Response.json(
							{ code: "import-busy" },
							{ status: 429, headers: { ...headers, "retry-after": "5" } },
						);
					activeUsers.add(session.user.id);
					try {
						const deadline = performance.now() + 20_000;
						if (
							(request.headers.get("content-type") ?? "")
								.split(";")[0]
								?.trim()
								.toLowerCase() !== "application/json"
						)
							throw new ImportRequestError("invalid-request", 415);
						let raw: unknown;
						try {
							raw = JSON.parse((await readRequest(request, 4096, 5000)).text);
						} catch (error) {
							if (error instanceof ImportRequestError) throw error;
							throw new ImportRequestError("invalid-request", 400);
						}
						const confirmation = confirmationSchema.safeParse(raw);
						if (!confirmation.success)
							throw new ImportRequestError("invalid-confirmation", 400);
						return response(
							await applyImportBatch(
								pool,
								session.user.id,
								pathId(request, true),
								confirmation.data,
								{ signal: request.signal, deadline },
							),
						);
					} finally {
						activeUsers.delete(session.user.id);
					}
				}),
			),
			{ parse: "none" },
		)
		.get(
			"/api/portability/import/sources",
			guards.guardedGet((_, session) =>
				handled(async () =>
					response({ sources: await listImportSources(pool, session.user.id) }),
				),
			),
		)
		.post(
			"/api/portability/import/plans",
			guards.guardedPost((request, session) =>
				handled(async () => {
					if (activeUsers.size >= 2 || activeUsers.has(session.user.id))
						return Response.json(
							{ code: "import-busy" },
							{ status: 429, headers: { ...headers, "retry-after": "5" } },
						);
					activeUsers.add(session.user.id);
					const deadline = performance.now() + 45_000;
					try {
						if (
							(request.headers.get("content-type") ?? "")
								.split(";")[0]
								?.trim()
								.toLowerCase() !== "application/json"
						)
							throw new ImportRequestError("invalid-request", 415);
						let raw: unknown;
						let receivedBytes = 0;
						try {
							const received = await readRequest(request);
							receivedBytes = received.bytes;
							raw = JSON.parse(received.text);
						} catch (error) {
							if (error instanceof ImportRequestError) throw error;
							throw new ImportRequestError("invalid-request", 400);
						}
						if (
							!object(raw) ||
							Object.keys(raw).length !== 3 ||
							Object.hasOwn(raw, "input") === Object.hasOwn(raw, "document") ||
							(Object.hasOwn(raw, "document") &&
								typeof raw.document !== "string") ||
							!Object.hasOwn(raw, "source") ||
							!Object.hasOwn(raw, "mappings")
						)
							throw new ImportRequestError("invalid-request", 400);
						if (
							typeof raw.document === "string" &&
							Buffer.byteLength(raw.document) > MAX_DOCUMENT_BYTES
						)
							throw new ImportRequestError("byte-limit", 413);
						const source = sourceSchema.safeParse(raw.source);
						if (
							!source.success ||
							(source.data.mode === "new" &&
								(!source.data.label.isWellFormed() ||
									source.data.label.includes("\u0000")))
						)
							throw new ImportRequestError("invalid-source", 400);
						const mapping = mappings(raw.mappings);
						if (
							Object.hasOwn(raw, "input") &&
							receivedBytes > PROVIDER_REQUEST_MAX_BYTES
						)
							throw new ImportRequestError("request-limit", 413);
						const provider = Object.hasOwn(raw, "input")
							? await prepareProviderImportRequest(raw.input, {
									exportedAt: new Date().toISOString(),
									signal: request.signal,
									deadline,
								})
							: null;
						const document =
							provider?.conversion.document ??
							parseImportDocument(raw.document as string, {
								historyPreview: true,
							});
						if (request.signal.aborted)
							throw new ImportRequestError("request-cancelled", 408);
						return response(
							await saveImportPlan(
								pool,
								session.user.id,
								source.data,
								document,
								mapping,
								{
									signal: request.signal,
									deadline,
									plannerVersion: 4,
									...(provider ? { inputBinding: provider.binding } : {}),
									...(document.schemaVersion === 2
										? { historyApply: true }
										: {}),
								},
							),
						);
					} finally {
						activeUsers.delete(session.user.id);
					}
				}),
			),
			{ parse: "none" },
		)
		.get(
			"/api/portability/import/plans/:id",
			guards.guardedGet((request, session) =>
				handled(async () => {
					const result = await getImportPlanStatus(
						pool,
						session.user.id,
						pathId(request),
					);
					return result
						? response(result)
						: response({ code: "not-found" }, 404);
				}),
			),
		)
		.post(
			"/api/portability/import/plans/:id/discard",
			guards.guardedPost((request, session) =>
				handled(async () => {
					const found = await discardImportPlan(
						pool,
						session.user.id,
						pathId(request, true),
					);
					return response(
						{ code: found ? "discarded" : "not-found" },
						found ? 200 : 404,
					);
				}),
			),
			{ parse: "none" },
		)
		.post(
			"/api/portability/import/sources/:id/discard",
			guards.guardedPost((request, session) =>
				handled(async () => {
					const found = await discardImportSource(
						pool,
						session.user.id,
						pathId(request, true),
					);
					return response(
						{ code: found ? "discarded" : "not-found" },
						found ? 200 : 404,
					);
				}),
			),
			{ parse: "none" },
		);
}
