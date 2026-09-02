import { Elysia } from "elysia";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { e2eEnabled } from "../../config/e2e.ts";
import { withUserContext } from "../../db/user-context.ts";
import { storageKeyFor } from "../../domain/attachment.ts";
import { e2eBlobSchema } from "../e2e/input.ts";
import type { Guards } from "../guards.ts";
import type { BlobStore } from "../storage/blob-store.ts";
import {
	type AttachmentAccessFailure,
	type AttachmentContext,
	attachmentQuotaWouldExceed,
	hasAttachmentWriteRole,
	validateAttachmentWrite,
} from "./quota.ts";
import { type AttachmentState, assertAttachmentTransition } from "./state.ts";

export type AttachmentRouteOptions = {
	quotaBytes?: number;
	reservationTtlMs?: number;
	now?: () => Date;
};

const DEFAULT_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_RESERVATION_TTL_MS = 60 * 60_000;

const identifier = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/);

const byteCount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const reserveBody = z
	.object({
		id: identifier,
		workspaceId: identifier,
		parentKind: z.enum(["task", "comment", "list"]),
		parentId: identifier,
		keyVersion: z.number().int().positive().max(2_147_483_647),
		filenameCiphertext: e2eBlobSchema,
		contentTypeCiphertext: e2eBlobSchema,
		dekWrapped: e2eBlobSchema,
		declaredBytes: byteCount,
		thumbnailDeclaredBytes: byteCount.nullable().optional().default(null),
	})
	.superRefine((body, context) => {
		if (
			!Number.isSafeInteger(
				body.declaredBytes + (body.thumbnailDeclaredBytes ?? 0),
			)
		) {
			context.addIssue({
				code: "custom",
				message: "combined attachment bytes exceed the safe integer range",
			});
		}
	});

const finalizeBody = z.object({ id: identifier });

type AttachmentRow = AttachmentContext & {
	id: string;
	state: AttachmentState;
	declaredBytes: number;
	observedBytes: number | null;
	ciphertextSha256: string | null;
	thumbnailDeclaredBytes: number | null;
	thumbnailObservedBytes: number | null;
	thumbnailCiphertextSha256: string | null;
	storageKey: string;
	thumbnailStorageKey: string | null;
	uploadedBy: string;
	reservationExpiresAt: Date | null;
};

type RouteResult = {
	response: Response | Record<string, unknown>;
	cleanupKeys?: string[];
};

class UploadTooLargeError extends Error {}

function errorForAccess(failure: AttachmentAccessFailure): Response {
	if (failure === "not-permitted" || failure === "parent-mismatch") {
		return new Response("Forbidden", { status: 403 });
	}
	return new Response("Conflict", { status: 409 });
}

function errorForInvalidation(failure: AttachmentAccessFailure): Response {
	return new Response(failure === "not-permitted" ? "Forbidden" : "Conflict", {
		status: failure === "not-permitted" ? 403 : 409,
	});
}

function attachmentIdFromPath(
	request: Request,
	action: "upload" | "download" | "thumbnail",
): string | null {
	const match = new RegExp(`^/api/attachments/([^/]+)/${action}$`).exec(
		new URL(request.url).pathname,
	);
	if (!match) return null;
	try {
		const decoded = decodeURIComponent(match[1] ?? "");
		return identifier.safeParse(decoded).success ? decoded : null;
	} catch {
		return null;
	}
}

function responseBody(
	source: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
	const iterator = source[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await iterator.next();
				if (next.done) {
					controller.close();
					return;
				}
				if (!(next.value instanceof Uint8Array)) {
					throw new Error("blob body must yield Uint8Array chunks");
				}
				controller.enqueue(next.value);
			} catch (error) {
				controller.error(error);
			}
		},
		async cancel() {
			await iterator.return?.();
		},
	});
}

async function parseJson<T>(
	request: Request,
	schema: z.ZodType<T>,
): Promise<T | null> {
	try {
		return schema.parse(await request.json());
	} catch {
		return null;
	}
}

async function attachmentForUpdate(
	client: PoolClient,
	id: string,
): Promise<AttachmentRow | null> {
	const result = await client.query<{
		id: string;
		workspace_id: string;
		parent_kind: AttachmentContext["parentKind"];
		parent_id: string;
		key_version: number;
		state: AttachmentState;
		declared_bytes: string;
		observed_bytes: string | null;
		ciphertext_sha256: string | null;
		thumbnail_declared_bytes: string | null;
		thumbnail_observed_bytes: string | null;
		thumbnail_ciphertext_sha256: string | null;
		storage_key: string;
		thumbnail_storage_key: string | null;
		uploaded_by: string;
		reservation_expires_at: Date | null;
	}>(
		`select id, workspace_id, parent_kind, parent_id, key_version, state,
		 declared_bytes, observed_bytes, ciphertext_sha256,
		 thumbnail_declared_bytes, thumbnail_observed_bytes,
		 thumbnail_ciphertext_sha256, storage_key, thumbnail_storage_key,
		 uploaded_by, reservation_expires_at
		 from attachment where id = $1 for update`,
		[id],
	);
	const row = result.rows[0];
	if (!row) return null;
	const declaredBytes = Number(row.declared_bytes);
	const observedBytes =
		row.observed_bytes === null ? null : Number(row.observed_bytes);
	const thumbnailDeclaredBytes =
		row.thumbnail_declared_bytes === null
			? null
			: Number(row.thumbnail_declared_bytes);
	const thumbnailObservedBytes =
		row.thumbnail_observed_bytes === null
			? null
			: Number(row.thumbnail_observed_bytes);
	if (
		!Number.isSafeInteger(declaredBytes) ||
		(observedBytes !== null && !Number.isSafeInteger(observedBytes)) ||
		(thumbnailDeclaredBytes !== null &&
			!Number.isSafeInteger(thumbnailDeclaredBytes)) ||
		(thumbnailObservedBytes !== null &&
			!Number.isSafeInteger(thumbnailObservedBytes))
	) {
		throw new Error("attachment byte count exceeds the safe integer range");
	}
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		parentKind: row.parent_kind,
		parentId: row.parent_id,
		keyVersion: row.key_version,
		state: row.state,
		declaredBytes,
		observedBytes,
		ciphertextSha256: row.ciphertext_sha256,
		thumbnailDeclaredBytes,
		thumbnailObservedBytes,
		thumbnailCiphertextSha256: row.thumbnail_ciphertext_sha256,
		storageKey: row.storage_key,
		thumbnailStorageKey: row.thumbnail_storage_key,
		uploadedBy: row.uploaded_by,
		reservationExpiresAt: row.reservation_expires_at,
	};
}

async function* requestBytes(
	request: Request,
	maxBytes: number,
): AsyncIterable<Uint8Array> {
	const declared = request.headers.get("content-length");
	if (
		declared !== null &&
		/^\d+$/.test(declared) &&
		Number(declared) > maxBytes
	) {
		throw new UploadTooLargeError();
	}
	const stream = request.body;
	if (!stream) return;
	const reader = stream.getReader();
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (!Number.isSafeInteger(total) || total > maxBytes) {
				await reader.cancel();
				throw new UploadTooLargeError();
			}
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

async function abortAttachment(
	client: PoolClient,
	row: AttachmentRow,
): Promise<void> {
	if (row.state !== "aborted") {
		assertAttachmentTransition(row.state, "aborted");
		await client.query(
			`update attachment set state = 'aborted'
			 where id = $1 and state = $2`,
			[row.id, row.state],
		);
	}
}

async function cleanupAndReturn(
	store: BlobStore,
	result: RouteResult,
): Promise<Response | Record<string, unknown>> {
	for (const key of result.cleanupKeys ?? []) await store.delete(key);
	return result.response;
}

function storageKeys(row: AttachmentRow): string[] {
	return row.thumbnailStorageKey
		? [row.storageKey, row.thumbnailStorageKey]
		: [row.storageKey];
}

async function downloadResponse(
	pool: Pool,
	store: BlobStore,
	id: string,
	userId: string,
	kind: "content" | "thumbnail",
): Promise<Response> {
	const storageColumn =
		kind === "content" ? "a.storage_key" : "a.thumbnail_storage_key";
	const row = await withUserContext(pool, userId, async (client) => {
		const result = await client.query<{
			storage_key: string | null;
			state: AttachmentState;
			deleted_at: Date | null;
			is_member: boolean;
		}>(
			`select ${storageColumn} as storage_key, a.state, a.deleted_at,
			 exists(select 1 from membership m
			        where m.workspace_id = a.workspace_id
			          and m.user_id = $2) as is_member
			 from attachment a where a.id = $1`,
			[id, userId],
		);
		return result.rows[0] ?? null;
	});
	if (!row) return new Response("Not Found", { status: 404 });
	if (!row.is_member) return new Response("Forbidden", { status: 403 });
	if (
		row.state !== "committed" ||
		row.deleted_at !== null ||
		row.storage_key === null
	) {
		return new Response("Not Found", { status: 404 });
	}
	return new Response(responseBody(await store.get(row.storage_key)), {
		headers: {
			"content-type": "application/octet-stream",
			"content-disposition": "attachment",
			"x-content-type-options": "nosniff",
		},
	});
}

export function attachmentRoutes(
	pool: Pool,
	guards: Guards,
	store: BlobStore,
	options: AttachmentRouteOptions = {},
) {
	const quotaBytes = options.quotaBytes ?? DEFAULT_QUOTA_BYTES;
	const reservationTtlMs =
		options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
	const now = options.now ?? (() => new Date());
	if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0) {
		throw new Error("attachment quota must be a positive safe integer");
	}
	if (!Number.isSafeInteger(reservationTtlMs) || reservationTtlMs <= 0) {
		throw new Error(
			"attachment reservation TTL must be a positive safe integer",
		);
	}

	return new Elysia()
		.post(
			"/api/attachments/reserve",
			guards.guardedPost(async (request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				const body = await parseJson(request, reserveBody);
				if (!body) return new Response("Bad Request", { status: 400 });
				return await withUserContext(pool, session.user.id, async (client) => {
					const context: AttachmentContext = body;
					const failure = await validateAttachmentWrite(
						client,
						session.user.id,
						context,
						{ lockWorkspace: true, lockContext: true },
					);
					if (failure) return errorForAccess(failure);
					if (
						await attachmentQuotaWouldExceed(
							client,
							body.workspaceId,
							body.declaredBytes + (body.thumbnailDeclaredBytes ?? 0),
							quotaBytes,
						)
					) {
						return new Response("Conflict", { status: 409 });
					}

					const expiresAt = new Date(now().getTime() + reservationTtlMs);
					const storageKey = storageKeyFor(body.workspaceId, body.id);
					const thumbnailStorageKey = body.thumbnailDeclaredBytes
						? storageKeyFor(body.workspaceId, body.id, "thumbnail")
						: null;
					try {
						await client.query(
							`insert into attachment
							 (id, workspace_id, parent_kind, parent_id, key_version,
							  state, filename_ciphertext, content_type_ciphertext,
							  dek_wrapped, declared_bytes, thumbnail_declared_bytes,
							  storage_key, thumbnail_storage_key, uploaded_by,
							  reservation_expires_at)
							 values ($1, $2, $3, $4, $5, 'reserved', $6, $7, $8,
							  $9, $10, $11, $12, $13, $14)`,
							[
								body.id,
								body.workspaceId,
								body.parentKind,
								body.parentId,
								body.keyVersion,
								body.filenameCiphertext,
								body.contentTypeCiphertext,
								body.dekWrapped,
								body.declaredBytes,
								body.thumbnailDeclaredBytes,
								storageKey,
								thumbnailStorageKey,
								session.user.id,
								expiresAt,
							],
						);
					} catch (error) {
						if (
							error instanceof Error &&
							"code" in error &&
							error.code === "23505"
						) {
							return new Response("Conflict", { status: 409 });
						}
						throw error;
					}
					return {
						id: body.id,
						uploadUrl: `/api/attachments/${body.id}/upload`,
						thumbnailUploadUrl: thumbnailStorageKey
							? `/api/attachments/${body.id}/thumbnail`
							: null,
					};
				});
			}),
		)
		.post(
			"/api/attachments/:id/upload",
			guards.guardedPost(async (request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				const id = attachmentIdFromPath(request, "upload");
				if (!id) return new Response("Bad Request", { status: 400 });
				try {
					const result = await withUserContext(
						pool,
						session.user.id,
						async (client): Promise<RouteResult> => {
							const row = await attachmentForUpdate(client, id);
							if (!row) {
								return {
									response: new Response("Not Found", { status: 404 }),
								};
							}
							if (row.uploadedBy !== session.user.id) {
								return {
									response: new Response("Not Found", { status: 404 }),
								};
							}
							if (row.state !== "reserved") {
								return {
									response: new Response("Conflict", { status: 409 }),
								};
							}
							if (
								!row.reservationExpiresAt ||
								row.reservationExpiresAt.getTime() <= now().getTime()
							) {
								await abortAttachment(client, row);
								return {
									response: new Response("Gone", { status: 410 }),
									cleanupKeys: storageKeys(row),
								};
							}
							let failure = await validateAttachmentWrite(
								client,
								session.user.id,
								row,
							);
							if (failure) {
								await abortAttachment(client, row);
								return {
									response: errorForInvalidation(failure),
									cleanupKeys: storageKeys(row),
								};
							}

							let observed: { bytes: number; sha256: string };
							try {
								observed = await store.put(
									row.storageKey,
									requestBytes(request, row.declaredBytes),
								);
							} catch (error) {
								if (!(error instanceof UploadTooLargeError)) throw error;
								await abortAttachment(client, row);
								return {
									response: new Response("Payload Too Large", { status: 413 }),
									cleanupKeys: storageKeys(row),
								};
							}
							if (
								!row.reservationExpiresAt ||
								row.reservationExpiresAt.getTime() <= now().getTime()
							) {
								await abortAttachment(client, row);
								return {
									response: new Response("Gone", { status: 410 }),
									cleanupKeys: storageKeys(row),
								};
							}
							failure = await validateAttachmentWrite(
								client,
								session.user.id,
								row,
								{ lockContext: true },
							);
							if (failure) {
								await abortAttachment(client, row);
								return {
									response: errorForInvalidation(failure),
									cleanupKeys: storageKeys(row),
								};
							}

							assertAttachmentTransition(row.state, "uploading");
							await client.query(
								`update attachment
								 set state = 'uploading', observed_bytes = $2,
								     ciphertext_sha256 = $3
								 where id = $1 and state = 'reserved'`,
								[row.id, observed.bytes, observed.sha256],
							);
							return {
								response: {
									id: row.id,
									state: "uploading",
									bytes: observed.bytes,
									sha256: observed.sha256,
								},
							};
						},
					);
					return await cleanupAndReturn(store, result);
				} catch (error) {
					if (error instanceof UploadTooLargeError) {
						return new Response("Payload Too Large", { status: 413 });
					}
					throw error;
				}
			}),
			{ parse: "none" },
		)
		.post(
			"/api/attachments/:id/thumbnail",
			guards.guardedPost(async (request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				const id = attachmentIdFromPath(request, "thumbnail");
				if (!id) return new Response("Bad Request", { status: 400 });
				try {
					const result = await withUserContext(
						pool,
						session.user.id,
						async (client): Promise<RouteResult> => {
							const row = await attachmentForUpdate(client, id);
							if (!row || row.uploadedBy !== session.user.id) {
								return {
									response: new Response("Not Found", { status: 404 }),
								};
							}
							if (
								row.state !== "uploading" ||
								row.thumbnailDeclaredBytes === null ||
								row.thumbnailStorageKey === null
							) {
								return {
									response: new Response("Conflict", { status: 409 }),
								};
							}
							if (
								!row.reservationExpiresAt ||
								row.reservationExpiresAt.getTime() <= now().getTime()
							) {
								await abortAttachment(client, row);
								return {
									response: new Response("Gone", { status: 410 }),
									cleanupKeys: storageKeys(row),
								};
							}
							let failure = await validateAttachmentWrite(
								client,
								session.user.id,
								row,
							);
							if (failure) {
								await abortAttachment(client, row);
								return {
									response: errorForInvalidation(failure),
									cleanupKeys: storageKeys(row),
								};
							}

							let observed: { bytes: number; sha256: string };
							try {
								observed = await store.put(
									row.thumbnailStorageKey,
									requestBytes(request, row.thumbnailDeclaredBytes),
								);
							} catch (error) {
								if (!(error instanceof UploadTooLargeError)) throw error;
								await abortAttachment(client, row);
								return {
									response: new Response("Payload Too Large", { status: 413 }),
									cleanupKeys: storageKeys(row),
								};
							}
							if (
								!row.reservationExpiresAt ||
								row.reservationExpiresAt.getTime() <= now().getTime()
							) {
								await abortAttachment(client, row);
								return {
									response: new Response("Gone", { status: 410 }),
									cleanupKeys: storageKeys(row),
								};
							}
							failure = await validateAttachmentWrite(
								client,
								session.user.id,
								row,
								{ lockContext: true },
							);
							if (failure) {
								await abortAttachment(client, row);
								return {
									response: errorForInvalidation(failure),
									cleanupKeys: storageKeys(row),
								};
							}

							await client.query(
								`update attachment
								 set thumbnail_observed_bytes = $2,
								     thumbnail_ciphertext_sha256 = $3
								 where id = $1 and state = 'uploading'`,
								[row.id, observed.bytes, observed.sha256],
							);
							return {
								response: {
									id: row.id,
									state: "uploading",
									bytes: observed.bytes,
									sha256: observed.sha256,
								},
							};
						},
					);
					return await cleanupAndReturn(store, result);
				} catch (error) {
					if (error instanceof UploadTooLargeError) {
						return new Response("Payload Too Large", { status: 413 });
					}
					throw error;
				}
			}),
			{ parse: "none" },
		)
		.post(
			"/api/attachments/finalize",
			guards.guardedPost(async (request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				const body = await parseJson(request, finalizeBody);
				if (!body) return new Response("Bad Request", { status: 400 });
				const result = await withUserContext(
					pool,
					session.user.id,
					async (client): Promise<RouteResult> => {
						const row = await attachmentForUpdate(client, body.id);
						if (!row) {
							return {
								response: new Response("Not Found", { status: 404 }),
							};
						}
						if (row.uploadedBy !== session.user.id) {
							return {
								response: new Response("Not Found", { status: 404 }),
							};
						}
						const resultBody = () => ({
							id: row.id,
							state: "committed",
							bytes: row.observedBytes,
							sha256: row.ciphertextSha256,
						});
						if (row.state === "committed") {
							const permitted = await hasAttachmentWriteRole(
								client,
								session.user.id,
								row.workspaceId,
							);
							return {
								response: permitted
									? resultBody()
									: new Response("Forbidden", { status: 403 }),
							};
						}
						if (row.state !== "uploading") {
							return {
								response: new Response("Conflict", { status: 409 }),
							};
						}
						if (
							!row.reservationExpiresAt ||
							row.reservationExpiresAt.getTime() <= now().getTime()
						) {
							await abortAttachment(client, row);
							return {
								response: new Response("Gone", { status: 410 }),
								cleanupKeys: storageKeys(row),
							};
						}
						const failure = await validateAttachmentWrite(
							client,
							session.user.id,
							row,
							{ lockContext: true },
						);
						if (failure) {
							await abortAttachment(client, row);
							return {
								response: errorForInvalidation(failure),
								cleanupKeys: storageKeys(row),
							};
						}
						if (
							row.observedBytes === null ||
							row.observedBytes !== row.declaredBytes ||
							(row.thumbnailDeclaredBytes === null
								? row.thumbnailObservedBytes !== null ||
									row.thumbnailStorageKey !== null ||
									row.thumbnailCiphertextSha256 !== null
								: row.thumbnailObservedBytes !== row.thumbnailDeclaredBytes ||
									row.thumbnailStorageKey === null ||
									row.thumbnailCiphertextSha256 === null)
						) {
							await abortAttachment(client, row);
							return {
								response: new Response("Conflict", { status: 409 }),
								cleanupKeys: storageKeys(row),
							};
						}
						assertAttachmentTransition(row.state, "committed");
						await client.query(
							`update attachment set state = 'committed',
							 committed_at = $2, reservation_expires_at = null
							 where id = $1 and state = 'uploading'`,
							[row.id, now()],
						);
						return { response: resultBody() };
					},
				);
				return await cleanupAndReturn(store, result);
			}),
		)
		.post(
			"/api/attachments/abort",
			guards.guardedPost(async (request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				const body = await parseJson(request, finalizeBody);
				if (!body) return new Response("Bad Request", { status: 400 });
				const result = await withUserContext(
					pool,
					session.user.id,
					async (client): Promise<RouteResult> => {
						const row = await attachmentForUpdate(client, body.id);
						if (!row || row.uploadedBy !== session.user.id) {
							return {
								response: new Response("Not Found", { status: 404 }),
							};
						}
						if (
							row.state !== "reserved" &&
							row.state !== "uploading" &&
							row.state !== "aborted"
						) {
							return {
								response: new Response("Conflict", { status: 409 }),
							};
						}
						await abortAttachment(client, row);
						return {
							response: { id: row.id, state: "aborted" },
							cleanupKeys: storageKeys(row),
						};
					},
				);
				return await cleanupAndReturn(store, result);
			}),
		)
		.get(
			"/api/attachments/:id/download",
			guards.guardedGet(async (request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				const id = attachmentIdFromPath(request, "download");
				if (!id) return new Response("Bad Request", { status: 400 });
				return await downloadResponse(
					pool,
					store,
					id,
					session.user.id,
					"content",
				);
			}),
		)
		.get(
			"/api/attachments/:id/thumbnail",
			guards.guardedGet(async (request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				const id = attachmentIdFromPath(request, "thumbnail");
				if (!id) return new Response("Bad Request", { status: 400 });
				return await downloadResponse(
					pool,
					store,
					id,
					session.user.id,
					"thumbnail",
				);
			}),
		);
}
