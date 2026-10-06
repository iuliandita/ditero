import { z } from "zod";
import type { E2eFetcher } from "./workspace-keys.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z
	.string()
	.min(1)
	.max(128)
	.refine((v) => !v.includes("\0") && v.isWellFormed());
const targetId = z
	.string()
	.regex(
		/^migration_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
const ordinal = z.number().int().min(0).max(50000);
const revision = z.number().int().min(0).max(2147483647);
const opaque = z
	.string()
	.min(1)
	.max(65536)
	.refine(
		(v) =>
			!v.includes("\0") &&
			v.isWellFormed() &&
			new TextEncoder().encode(v).length <= 65536,
	);
const bytes = z.number().int().min(1).max(16777216);
const preparedSchema = z
	.strictObject({
		id: targetId,
		keyVersion: revision.min(1),
		filenameCiphertext: opaque,
		contentTypeCiphertext: opaque,
		dekWrapped: opaque,
		declaredBytes: bytes,
		ciphertextSha256: hash,
		thumbnailDeclaredBytes: bytes.nullable(),
		thumbnailCiphertextSha256: hash.nullable(),
	})
	.refine(
		(v) =>
			v.declaredBytes + (v.thumbnailDeclaredBytes ?? 0) <= 16777216 &&
			(v.thumbnailDeclaredBytes === null) ===
				(v.thumbnailCiphertextSha256 === null),
	);
const requestSchema = z.strictObject({
	ordinal,
	sourceFingerprint: hash,
	expectedRevision: revision,
	prepared: preparedSchema,
});
const bindingSchema = z.strictObject({
	ownerId: id,
	jobId: hash,
	sourceId: id,
	documentDigest: hash,
	mappingDigest: hash,
	planDigest: hash,
});
const parentSchema = z.strictObject({
	ordinal,
	sourceAttachmentId: id,
	sourceAttachmentFingerprint: hash,
	destinationParent: z
		.strictObject({
			kind: z.enum(["list", "task", "comment"]),
			id,
			workspaceId: id,
		})
		.nullable(),
	blockedReason: z
		.enum([
			"uncommitted-source",
			"parent-unapplied",
			"workspace-mismatch",
			"parent-unavailable",
			"parent-changed",
			"not-permitted",
			"historical-proof-unavailable",
		])
		.nullable(),
});
const pageSchema = bindingSchema.extend({
	items: z.array(parentSchema).max(64),
	nextAfterOrdinal: ordinal.nullable(),
});
const reservationSchema = z.strictObject({
	associationId: z.string().uuid(),
	revision,
	attemptId: z.string().uuid().nullable(),
	targetAttachmentId: targetId.nullable(),
	committed: z.boolean(),
	committedAt: z.iso.datetime({ offset: true }).nullable(),
	attachmentState: z
		.enum(["reserved", "uploading", "committed", "aborted", "deleting"])
		.nullable(),
});
const destinationSchema = z.strictObject({
	kind: z.enum(["list", "task", "comment"]),
	id,
	workspaceId: id,
});
const inspectionSchema = reservationSchema
	.extend({
		...bindingSchema.shape,
		sourceFingerprint: hash,
		destinationParent: destinationSchema,
		reservationExpiresAt: z.iso.datetime({ offset: true }).nullable(),
		recoverable: z.boolean(),
	})
	.refine(
		(value) =>
			value.revision >= 1 &&
			value.attemptId !== null &&
			value.targetAttachmentId !== null &&
			value.committed === (value.committedAt !== null) &&
			(!value.committed ||
				(!value.recoverable &&
					(value.attachmentState === "committed" ||
						value.attachmentState === "deleting" ||
						value.attachmentState === null))) &&
			(value.committed || value.attachmentState !== "committed"),
	);
const recoveryRequestSchema = z
	.strictObject({
		ordinal,
		sourceFingerprint: hash,
		previous: z.strictObject({
			associationId: z.string().uuid(),
			attemptId: z.string().uuid(),
			targetAttachmentId: targetId,
			revision: revision.min(1),
		}),
		prepared: preparedSchema,
		retireLive: z.boolean(),
	})
	.refine((value) => value.prepared.id !== value.previous.targetAttachmentId);
const recoverySchema = z.strictObject({
	outcome: z.enum(["committed", "reserved", "recovery-required"]),
	status: inspectionSchema,
});
const receiptSchema = z.strictObject({
	id: targetId,
	state: z.enum(["uploading", "committed"]),
	bytes: z.number().int().positive(),
	sha256: hash,
});
export type MigrationInspection = z.infer<typeof inspectionSchema>;
export type MigrationRecoveryRequest = z.infer<typeof recoveryRequestSchema>;
export type MigrationRecovery = z.infer<typeof recoverySchema>;
export type MigrationInspectionExpected = {
	sourceFingerprint: string;
	destinationParent: MigrationInspection["destinationParent"];
};
export type PreparedMigration = z.infer<typeof preparedSchema>;
export type MigrationReservationRequest = z.infer<typeof requestSchema>;
export type MigrationReservation = z.infer<typeof reservationSchema>;
export type MigrationParentPage = z.infer<typeof pageSchema>;
export type MigrationBinding = z.infer<typeof bindingSchema>;
export type MigrationWitness = Pick<
	MigrationReservation,
	"attemptId" | "targetAttachmentId" | "revision"
>;

export class MigrationTransportError extends Error {
	constructor(
		public readonly code: string,
		public readonly status: number | null,
		public readonly uncertain: boolean,
	) {
		super(code);
		this.name = "MigrationTransportError";
	}
}

// Native transports need their own captured-session bridge; this adapter uses browser cookies.
export function createAttachmentMigrationApi(options: {
	binding: MigrationBinding;
	checkpoint: () => void;
	fetcher?: E2eFetcher;
}) {
	const binding = bindingSchema.parse(options.binding);
	const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
	const base = `/api/portability/import/plans/${binding.jobId}`;
	const check = (signal?: AbortSignal) => {
		options.checkpoint();
		signal?.throwIfAborted();
	};
	async function call<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit = {},
		signal?: AbortSignal,
		cap = 16384,
	): Promise<T> {
		const mutation = init.method === "POST";
		check(signal);
		let response: Response;
		try {
			response = await fetcher(path, {
				...init,
				credentials: "same-origin",
				cache: "no-store",
				signal,
			});
		} catch {
			throw new MigrationTransportError("response-lost", null, mutation);
		}
		try {
			check(signal);
		} catch {
			void response.body?.cancel().catch(() => {});
			throw new MigrationTransportError(
				"ownership-lost",
				response.status,
				mutation,
			);
		}
		if (!response.ok) cap = 4096;
		const uncertain =
			mutation &&
			(response.ok || response.status === 408 || response.status >= 500);
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			if (
				!/^application\/json(?:;|$)/i.test(
					response.headers.get("content-type") ?? "",
				)
			)
				throw Error("content-type");
			const length = response.headers.get("content-length");
			if (
				length !== null &&
				(!/^\d+$/.test(length) ||
					!Number.isSafeInteger(Number(length)) ||
					Number(length) > cap)
			)
				throw Error("size");
			if (!response.body) throw Error("body");
			reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let total = 0;
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(Error("deadline")), 5000);
				onAbort = () => reject(Error("aborted"));
				signal?.addEventListener("abort", onAbort, { once: true });
			});
			while (true) {
				check(signal);
				const part = await Promise.race([reader.read(), deadline]);
				check(signal);
				if (part.done) break;
				total += part.value.length;
				if (total > cap) throw Error("size");
				chunks.push(part.value);
			}
			const joined = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				joined.set(chunk, offset);
				offset += chunk.length;
			}
			const value: unknown = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(joined),
			);
			if (!response.ok) {
				const error = z
					.object({ code: z.string().regex(/^[a-z0-9-]{1,128}$/) })
					.safeParse(value);
				throw new MigrationTransportError(
					error.success ? error.data.code : "http-error",
					response.status,
					uncertain,
				);
			}
			return schema.parse(value);
		} catch (error) {
			if (error instanceof MigrationTransportError) throw error;
			throw new MigrationTransportError(
				response.ok ? "invalid-response" : "http-error",
				response.status,
				uncertain,
			);
		} finally {
			if (timer) clearTimeout(timer);
			if (onAbort) signal?.removeEventListener("abort", onAbort);
			if (reader) void reader.cancel().catch(() => {});
			else void response.body?.cancel().catch(() => {});
			reader?.releaseLock();
		}
	}
	const json = (body: unknown): RequestInit => {
		const serialized = JSON.stringify(body);
		if (new TextEncoder().encode(serialized).length > 262144)
			throw new MigrationTransportError("request-too-large", null, false);
		return {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: serialized,
		};
	};
	function witness(result: MigrationReservation, expected: MigrationWitness) {
		if (
			result.targetAttachmentId !== expected.targetAttachmentId ||
			result.attemptId !== expected.attemptId ||
			result.revision !== expected.revision
		)
			throw new MigrationTransportError(
				"reservation-identity-mismatch",
				200,
				true,
			);
		return result;
	}
	function inspection(
		result: MigrationInspection,
		expected: MigrationInspectionExpected,
		uncertain = false,
	) {
		for (const key of Object.keys(binding) as (keyof MigrationBinding)[])
			if (result[key] !== binding[key])
				throw new MigrationTransportError(
					"migration-binding-mismatch",
					200,
					uncertain,
				);
		if (
			result.sourceFingerprint !== expected.sourceFingerprint ||
			result.destinationParent.kind !== expected.destinationParent.kind ||
			result.destinationParent.id !== expected.destinationParent.id ||
			result.destinationParent.workspaceId !==
				expected.destinationParent.workspaceId
		)
			throw new MigrationTransportError(
				"migration-binding-mismatch",
				200,
				uncertain,
			);
		return result;
	}
	let next = -1;
	const seen = new Set<string>();
	return {
		async parents(
			query: { afterOrdinal: number; limit: number },
			signal?: AbortSignal,
		) {
			z.strictObject({
				afterOrdinal: z.number().int().min(-1).max(50000),
				limit: z.number().int().min(1).max(64),
			}).parse(query);
			if (query.afterOrdinal !== next)
				throw new MigrationTransportError(
					"parent-cursor-mismatch",
					null,
					false,
				);
			const page = await call(
				`${base}/attachment-parents?afterOrdinal=${query.afterOrdinal}&limit=${query.limit}`,
				pageSchema,
				{},
				signal,
				262144,
			);
			for (const key of Object.keys(binding) as (keyof MigrationBinding)[])
				if (page[key] !== binding[key])
					throw new MigrationTransportError(
						"parent-binding-mismatch",
						200,
						false,
					);
			let previous = query.afterOrdinal;
			const additions: string[] = [];
			for (const item of page.items) {
				if (
					item.ordinal <= previous ||
					seen.has(item.sourceAttachmentId) ||
					additions.includes(item.sourceAttachmentId)
				)
					throw new MigrationTransportError(
						"parent-order-mismatch",
						200,
						false,
					);
				previous = item.ordinal;
				additions.push(item.sourceAttachmentId);
			}
			if (
				page.items.length > query.limit ||
				(page.nextAfterOrdinal !== null &&
					(page.items.length === 0 || page.nextAfterOrdinal !== previous))
			)
				throw new MigrationTransportError("parent-cursor-mismatch", 200, false);
			for (const value of additions) seen.add(value);
			next = page.nextAfterOrdinal ?? 50001;
			return page;
		},
		async inspect(
			value: number,
			expected: MigrationInspectionExpected,
			signal?: AbortSignal,
		) {
			ordinal.parse(value);
			return inspection(
				await call(
					`${base}/attachment-migrations?ordinal=${value}`,
					inspectionSchema,
					{},
					signal,
				),
				expected,
			);
		},
		async recover(
			input: MigrationRecoveryRequest,
			expected: MigrationInspectionExpected,
			signal?: AbortSignal,
		) {
			const request = recoveryRequestSchema.parse(input);
			const result = await call(
				`${base}/attachment-recoveries`,
				recoverySchema,
				json(request),
				signal,
			);
			const value = inspection(result.status, expected, true);
			const valid =
				result.outcome === "committed"
					? value.committed &&
						value.associationId === request.previous.associationId
					: !value.committed &&
						value.associationId === request.previous.associationId &&
						value.targetAttachmentId === request.prepared.id &&
						value.revision === request.previous.revision + 1 &&
						(result.outcome === "reserved"
							? !value.recoverable &&
								(value.attachmentState === "reserved" ||
									value.attachmentState === "uploading")
							: value.recoverable);
			if (!valid)
				throw new MigrationTransportError(
					"reservation-identity-mismatch",
					200,
					true,
				);
			return result;
		},
		async reserve(input: MigrationReservationRequest, signal?: AbortSignal) {
			const request = requestSchema.parse(input);
			const result = await call(
				`${base}/attachment-reservations`,
				reservationSchema,
				json(request),
				signal,
			);
			if (
				result.targetAttachmentId !== request.prepared.id ||
				!result.attemptId ||
				result.revision !==
					(request.expectedRevision === 0 ? 1 : request.expectedRevision) ||
				result.committed !== (result.committedAt !== null)
			)
				throw new MigrationTransportError(
					"reservation-identity-mismatch",
					200,
					true,
				);
			return result;
		},
		async status(
			value: number,
			expected?: MigrationWitness,
			signal?: AbortSignal,
		) {
			ordinal.parse(value);
			const result = await call(
				`${base}/attachment-reservations?ordinal=${value}`,
				reservationSchema,
				{},
				signal,
			);
			return expected ? witness(result, expected) : result;
		},
		async upload(
			prepared: PreparedMigration,
			body: Blob,
			signal?: AbortSignal,
		) {
			return transfer(prepared, body, false, signal);
		},
		async thumbnail(
			prepared: PreparedMigration,
			body: Blob,
			signal?: AbortSignal,
		) {
			return transfer(prepared, body, true, signal);
		},
		async finalize(prepared: PreparedMigration, signal?: AbortSignal) {
			const p = preparedSchema.parse(prepared);
			const result = await call(
				"/api/attachments/finalize",
				receiptSchema,
				json({ id: p.id }),
				signal,
			);
			if (
				result.id !== p.id ||
				result.state !== "committed" ||
				result.bytes !== p.declaredBytes ||
				result.sha256 !== p.ciphertextSha256
			)
				throw new MigrationTransportError(
					"attachment-identity-mismatch",
					200,
					true,
				);
			return result;
		},
		async abort(value: string, signal?: AbortSignal) {
			targetId.parse(value);
			const result = await call(
				"/api/attachments/abort",
				z.strictObject({ id: targetId, state: z.literal("aborted") }),
				json({ id: value }),
				signal,
			);
			if (result.id !== value)
				throw new MigrationTransportError(
					"attachment-identity-mismatch",
					200,
					true,
				);
			return result;
		},
	};
	async function transfer(
		prepared: PreparedMigration,
		body: Blob,
		thumbnail: boolean,
		signal?: AbortSignal,
	) {
		const p = preparedSchema.parse(prepared);
		const size = thumbnail ? p.thumbnailDeclaredBytes : p.declaredBytes;
		const digest = thumbnail ? p.thumbnailCiphertextSha256 : p.ciphertextSha256;
		if (size === null || body.size !== size)
			throw new MigrationTransportError(
				"ciphertext-size-mismatch",
				null,
				false,
			);
		const result = await call(
			`/api/attachments/${p.id}/${thumbnail ? "thumbnail" : "upload"}`,
			receiptSchema,
			{
				method: "POST",
				headers: { "content-type": "application/octet-stream" },
				body,
			},
			signal,
		);
		if (
			result.id !== p.id ||
			result.state !== "uploading" ||
			result.bytes !== size ||
			result.sha256 !== digest
		)
			throw new MigrationTransportError(
				"attachment-identity-mismatch",
				200,
				true,
			);
		return result;
	}
}
