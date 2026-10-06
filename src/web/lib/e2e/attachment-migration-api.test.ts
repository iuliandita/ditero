import { describe, expect, it, vi } from "vitest";
import {
	createAttachmentMigrationApi,
	MigrationTransportError,
	type PreparedMigration,
} from "./attachment-migration-api.ts";

const hash = "a".repeat(64);
const binding = {
	ownerId: "owner",
	jobId: hash,
	sourceId: "source",
	documentDigest: hash,
	mappingDigest: hash,
	planDigest: hash,
};
const prepared: PreparedMigration = {
	id: "migration_12345678-1234-4123-8123-123456789abc",
	keyVersion: 1,
	filenameCiphertext: "opaque",
	contentTypeCiphertext: "opaque",
	dekWrapped: "opaque",
	declaredBytes: 3,
	ciphertextSha256: hash,
	thumbnailDeclaredBytes: null,
	thumbnailCiphertextSha256: null,
};
const result = {
	associationId: "12345678-1234-4123-8123-123456789abc",
	revision: 1,
	attemptId: "12345678-1234-4123-8123-123456789abd",
	targetAttachmentId: prepared.id,
	committed: false,
	committedAt: null,
	attachmentState: "reserved",
};
const request = {
	ordinal: 0,
	sourceFingerprint: hash,
	expectedRevision: 0,
	prepared,
};
const response = (value: unknown) => Response.json(value);
const item = (ordinal: number, sourceAttachmentId = `source-${ordinal}`) => ({
	ordinal,
	sourceAttachmentId,
	sourceAttachmentFingerprint: hash,
	destinationParent: { kind: "list", id: "list", workspaceId: "workspace" },
	blockedReason: null,
});
describe("attachment migration browser transport", () => {
	it("binds session paths, request and receipt without retry", async () => {
		const fetcher = vi.fn().mockResolvedValue(response(result));
		const checkpoint = vi.fn();
		const api = createAttachmentMigrationApi({ binding, checkpoint, fetcher });
		expect(await api.reserve(request)).toEqual(result);
		expect(fetcher).toHaveBeenCalledOnce();
		expect(fetcher.mock.calls[0][0]).toBe(
			`/api/portability/import/plans/${hash}/attachment-reservations`,
		);
		expect(fetcher.mock.calls[0][1]).toMatchObject({
			credentials: "same-origin",
			cache: "no-store",
			method: "POST",
			body: JSON.stringify(request),
		});
		expect(checkpoint.mock.calls.length).toBeGreaterThan(2);
	});
	it("preserves HTTP refusal and does not implicitly abort", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(new Response("Forbidden", { status: 403 }));
		const api = createAttachmentMigrationApi({
			binding,
			checkpoint: () => {},
			fetcher,
		});
		await expect(api.reserve(request)).rejects.toMatchObject({
			status: 403,
			uncertain: false,
		});
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it("marks lost mutation responses uncertain", async () => {
		const fetcher = vi.fn().mockRejectedValue(Error("network"));
		const api = createAttachmentMigrationApi({
			binding,
			checkpoint: () => {},
			fetcher,
		});
		await expect(api.reserve(request)).rejects.toMatchObject({
			code: "response-lost",
			uncertain: true,
		});
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it.each([
		408, 500, 502, 503, 504,
	])("reconciles ambiguous mutation HTTP %s without retry", async (status) => {
		for (const json of [false, true]) {
			const fetcher = vi
				.fn()
				.mockResolvedValue(
					json
						? Response.json({ code: "upstream-unavailable" }, { status })
						: new Response("Gateway unavailable", { status }),
				);
			const api = createAttachmentMigrationApi({
				binding,
				checkpoint: () => {},
				fetcher,
			});
			await expect(api.reserve(request)).rejects.toMatchObject({
				status,
				uncertain: true,
			});
			expect(fetcher).toHaveBeenCalledOnce();
		}
	});
	it.each([
		"content-type",
		"content-length",
	])("cancels an unread body after %s refusal", async (mode) => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		const headers = {
			"content-type":
				mode === "content-type" ? "text/html" : "application/json",
			...(mode === "content-length" ? { "content-length": "99999999" } : {}),
		};
		const api = createAttachmentMigrationApi({
			binding,
			checkpoint: () => {},
			fetcher: vi.fn().mockResolvedValue(new Response(body, { headers })),
		});
		await expect(api.reserve(request)).rejects.toMatchObject({
			code: "invalid-response",
			uncertain: true,
		});
		expect(cancel).toHaveBeenCalledOnce();
	});
	it.each([
		"target",
		"revision",
		"extra",
		"state",
	])("rejects invalid reservation %s", async (mode) => {
		const changed = {
			...result,
			...(mode === "target"
				? {
						targetAttachmentId:
							"migration_12345678-1234-4123-8123-123456789abd",
					}
				: mode === "revision"
					? { revision: 2 }
					: mode === "extra"
						? { uploadUrl: "https://evil.test" }
						: { attachmentState: "unknown" }),
		};
		const api = createAttachmentMigrationApi({
			binding,
			checkpoint: () => {},
			fetcher: async () => response(changed),
		});
		await expect(api.reserve(request)).rejects.toMatchObject({
			uncertain: true,
		});
	});
	it("checks captured status witness", async () => {
		const api = createAttachmentMigrationApi({
			binding,
			checkpoint: () => {},
			fetcher: async () => response(result),
		});
		await expect(
			api.status(0, { ...result, revision: 2 }),
		).rejects.toBeInstanceOf(MigrationTransportError);
	});
	it("requests bounded pages explicitly and rejects repeated source identity", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				response({ ...binding, items: [item(0)], nextAfterOrdinal: 0 }),
			)
			.mockResolvedValueOnce(
				response({
					...binding,
					items: [item(1, "source-0")],
					nextAfterOrdinal: null,
				}),
			);
		const api = createAttachmentMigrationApi({
			binding,
			checkpoint: () => {},
			fetcher,
		});
		await api.parents({ afterOrdinal: -1, limit: 1 });
		expect(fetcher).toHaveBeenCalledOnce();
		await expect(
			api.parents({ afterOrdinal: 0, limit: 1 }),
		).rejects.toMatchObject({ code: "parent-order-mismatch" });
	});
	it.each([
		"pins",
		"order",
		"cursor",
	])("refuses changed parent %s", async (mode) => {
		const page = {
			...binding,
			items: [item(1), item(2)],
			nextAfterOrdinal: null,
			...(mode === "pins"
				? { mappingDigest: "b".repeat(64) }
				: mode === "order"
					? { items: [item(2), item(1)] }
					: { nextAfterOrdinal: 0 }),
		};
		const api = createAttachmentMigrationApi({
			binding,
			checkpoint: () => {},
			fetcher: async () => response(page),
		});
		await expect(
			api.parents({ afterOrdinal: -1, limit: 2 }),
		).rejects.toBeInstanceOf(MigrationTransportError);
	});
	it("refuses oversized streamed JSON even without a length header", async () => {
		const api = createAttachmentMigrationApi({
			binding,
			checkpoint: () => {},
			fetcher: async () =>
				new Response(" ".repeat(16385), {
					headers: { "content-type": "application/json" },
				}),
		});
		await expect(api.reserve(request)).rejects.toMatchObject({
			code: "invalid-response",
			uncertain: true,
		});
	});
	it("ownership loss after fetch is uncertain for mutation", async () => {
		let checks = 0;
		const api = createAttachmentMigrationApi({
			binding,
			checkpoint: () => {
				if (++checks === 2) throw Error("retired");
			},
			fetcher: async () => response(result),
		});
		await expect(api.reserve(request)).rejects.toMatchObject({
			code: "ownership-lost",
			uncertain: true,
		});
	});
	it("does not fetch after initial cancellation", async () => {
		const fetcher = vi.fn();
		const signal = AbortSignal.abort();
		const api = createAttachmentMigrationApi({
			binding,
			checkpoint: () => {},
			fetcher,
		});
		await expect(api.reserve(request, signal)).rejects.toBeDefined();
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("validates exact upload bytes and finalize identity", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				response({
					id: prepared.id,
					state: "uploading",
					bytes: 3,
					sha256: hash,
				}),
			)
			.mockResolvedValueOnce(
				response({
					id: prepared.id,
					state: "committed",
					bytes: 3,
					sha256: hash,
				}),
			);
		const api = createAttachmentMigrationApi({
			binding,
			checkpoint: () => {},
			fetcher,
		});
		await api.upload(prepared, new Blob(["abc"]));
		await api.finalize(prepared);
		await expect(api.upload(prepared, new Blob(["ab"]))).rejects.toMatchObject({
			code: "ciphertext-size-mismatch",
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it("rejects unknown prepared fields before network", async () => {
		const fetcher = vi.fn();
		const api = createAttachmentMigrationApi({
			binding,
			checkpoint: () => {},
			fetcher,
		});
		await expect(
			api.reserve({
				...request,
				prepared: { ...prepared, url: "evil" },
			} as typeof request),
		).rejects.toBeDefined();
		expect(fetcher).not.toHaveBeenCalled();
	});
});

it("retains bounded server error codes", async () => {
	const api = createAttachmentMigrationApi({
		binding,
		checkpoint: () => {},
		fetcher: async () =>
			Response.json({ code: "migration-target-conflict" }, { status: 409 }),
	});
	await expect(api.reserve(request)).rejects.toMatchObject({
		code: "migration-target-conflict",
		status: 409,
		uncertain: false,
	});
});
it("cancels a pending response reader without waiting for its body", async () => {
	const controller = new AbortController();
	const stream = new ReadableStream<Uint8Array>({ start() {} });
	const api = createAttachmentMigrationApi({
		binding,
		checkpoint: () => {},
		fetcher: async () =>
			new Response(stream, { headers: { "content-type": "application/json" } }),
	});
	const pending = api.reserve(request, controller.signal);
	await Promise.resolve();
	await Promise.resolve();
	controller.abort();
	await expect(pending).rejects.toMatchObject({ uncertain: true });
});

it("bounds escaped JSON requests before network", async () => {
	const fetcher = vi.fn();
	const api = createAttachmentMigrationApi({
		binding,
		checkpoint: () => {},
		fetcher,
	});
	const opaque = "\u0001".repeat(65536);
	await expect(
		api.reserve({
			...request,
			prepared: {
				...prepared,
				filenameCiphertext: opaque,
				contentTypeCiphertext: opaque,
				dekWrapped: opaque,
			},
		}),
	).rejects.toMatchObject({ code: "request-too-large", uncertain: false });
	expect(fetcher).not.toHaveBeenCalled();
});
