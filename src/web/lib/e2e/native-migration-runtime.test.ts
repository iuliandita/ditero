import { expect, test, vi } from "vitest";
import { createAttachmentRuntime } from "../../../../apps/android/src/attachment-runtime.ts";
import type { callAttachment } from "../../../../apps/android/src/bridge.ts";
import type { PreparedMigration } from "./attachment-migration-api.ts";

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
	thumbnailDeclaredBytes: 2,
	thumbnailCiphertextSha256: hash,
};
const reservation = {
	associationId: "12345678-1234-4123-8123-123456789abc",
	revision: 1,
	attemptId: "12345678-1234-4123-8123-123456789abd",
	targetAttachmentId: prepared.id,
	committed: false,
	committedAt: null,
	attachmentState: "reserved",
};
const input = {
	ordinal: 0,
	sourceFingerprint: hash,
	expectedRevision: 0,
	prepared,
};
const expected = {
	sourceFingerprint: hash,
	destinationParent: {
		kind: "list" as const,
		id: "list",
		workspaceId: "workspace",
	},
};
const inspection = {
	...reservation,
	...binding,
	...expected,
	reservationExpiresAt: "2026-10-08T12:00:00Z",
	recoverable: false,
};
const json = (body: unknown, status = 200) => ({
	ok: status < 300,
	status,
	body: JSON.stringify(body),
});
function harness(handler?: typeof callAttachment) {
	let current = true;
	const call = vi.fn<typeof callAttachment>(async (op, body) => {
		if (op === "archive.migration.jobs")
			return json({
				items: [{ ...binding, label: "Source" }],
				nextAfterJobId: null,
			});
		if (handler) return handler(op, body);
		if (op === "archive.migration.reserve") return json(reservation);
		if (op === "archive.migration.inspect") return json(inspection);
		if (op === "archive.migration.status")
			return json({
				...reservation,
				upload: {
					declaredBytes: 3,
					ciphertextSha256: hash,
					thumbnailDeclaredBytes: 2,
					thumbnailCiphertextSha256: hash,
				},
			});
		if (op === "archive.migration.upload.begin")
			return { ok: true, transferId: "transfer-A" };
		if (op === "upload.finish")
			return json({
				id: prepared.id,
				state: "uploading",
				bytes: 3,
				sha256: hash,
			});
		return { ok: true };
	});
	const runtime = createAttachmentRuntime(
		() => {
			if (!current) throw Error("retired");
		},
		"scope",
		true,
		call,
		false,
		false,
		true,
		"owner",
	);
	return {
		runtime,
		call,
		retire: () => {
			current = false;
		},
	};
}
function migration(h: ReturnType<typeof harness>) {
	const result = h.runtime.archiveMigration;
	if (!result) throw Error("missing migration runtime");
	return result;
}
async function bound(h: ReturnType<typeof harness>) {
	await migration(h).jobs({ limit: 64 });
	return migration(h).bind(binding);
}
test("migration capability is explicit, desktop-only and jobs bind owner evidence", async () => {
	const call = vi.fn<typeof callAttachment>();
	expect(
		createAttachmentRuntime(() => {}, "a", true, call).archiveMigration,
	).toBeUndefined();
	expect(
		createAttachmentRuntime(
			() => {},
			"a",
			false,
			call,
			false,
			false,
			true,
			"owner",
		).archiveMigration,
	).toBeUndefined();
	const h = harness();
	expect(() => migration(h).bind(binding)).toThrow(
		"migration-binding-mismatch",
	);
	await bound(h);
	expect(h.call).toHaveBeenCalledWith("archive.migration.jobs", { limit: 64 });
	expect(() => migration(h).bind({ ...binding, ownerId: "other" })).toThrow();
});
test("migration reserve/status and streamed uploads use exact native tuples without ordinary reserve", async () => {
	const h = harness();
	const api = await bound(h);
	await api.reserve(input);
	expect(await api.status(0, reservation)).toEqual(reservation);
	expect(await api.upload(prepared, new Blob(["abc"]))).toEqual({
		id: prepared.id,
		state: "uploading",
		bytes: 3,
		sha256: hash,
	});
	expect(h.call).toHaveBeenCalledWith("archive.migration.reserve", {
		jobId: hash,
		reservation: input,
	});
	expect(h.call).toHaveBeenCalledWith("archive.migration.upload.begin", {
		jobId: hash,
		ordinal: 0,
		associationId: reservation.associationId,
		attemptId: reservation.attemptId,
		targetAttachmentId: prepared.id,
		revision: 1,
		thumbnail: false,
	});
	expect(h.call).toHaveBeenCalledWith("upload.write", {
		transferId: "transfer-A",
		seq: 0,
		data: "YWJj",
	});
	expect(h.call).toHaveBeenCalledWith("upload.finish", {
		transferId: "transfer-A",
		seq: 1,
	});
	expect(h.call.mock.calls.some(([op]) => op === "attachment.reserve")).toBe(
		false,
	);
});
test("fresh binding can continue an exact inspected existing reservation", async () => {
	const h = harness();
	const api = await bound(h);
	await api.inspect(0, expected);
	await api.upload(prepared, new Blob(["abc"]));
	expect(h.call).toHaveBeenCalledWith("archive.migration.inspect", {
		jobId: hash,
		ordinal: 0,
	});
});
test("lost mutation fences fresh API bindings until exact inspection reconciles", async () => {
	let lost = true;
	const h = harness(async (op) => {
		if (op === "archive.migration.reserve") {
			if (lost) {
				lost = false;
				throw Error("network");
			}
			return json(reservation);
		}
		if (op === "archive.migration.inspect") return json(inspection);
		return { ok: true };
	});
	const api = await bound(h);
	await expect(api.reserve(input)).rejects.toMatchObject({ uncertain: true });
	const replacement = migration(h).bind(binding);
	await expect(replacement.reserve(input)).rejects.toMatchObject({
		code: "migration-reconciliation-required",
	});
	await replacement.inspect(0, expected);
	await expect(replacement.reserve(input)).resolves.toEqual(reservation);
});
test("abort after reserve dispatch is uncertain and cannot cancel unrelated capabilities", async () => {
	let resolve!: (value: Awaited<ReturnType<typeof callAttachment>>) => void;
	const h = harness(async (op) =>
		op === "archive.migration.reserve"
			? new Promise((r) => {
					resolve = r;
				})
			: { ok: true },
	);
	const api = await bound(h);
	const abort = new AbortController();
	const pending = api.reserve(input, abort.signal);
	abort.abort();
	await expect(pending).rejects.toMatchObject({ uncertain: true });
	resolve(json(reservation));
	await expect(api.finalize(prepared)).rejects.toMatchObject({
		code: "migration-reconciliation-required",
	});
	expect(
		h.call.mock.calls.some(
			([op]) => op.endsWith("cancelPending") || op === "attachment.cancel",
		),
	).toBe(false);
});
test("retirement cannot dispatch cleanup or expose a late control reply to replacement owner", async () => {
	let resolve!: (value: Awaited<ReturnType<typeof callAttachment>>) => void;
	const h = harness(
		async () =>
			new Promise((r) => {
				resolve = r;
			}),
	);
	const api = await bound(h);
	const pending = api.reserve(input);
	h.retire();
	resolve(json(reservation));
	await expect(pending).rejects.toMatchObject({ uncertain: true });
	expect(h.call).toHaveBeenCalledTimes(2);
});
test("invalid upload receipt fences finalize and wrong local size never starts upload", async () => {
	const h = harness(async (op) =>
		op === "archive.migration.reserve"
			? json(reservation)
			: op === "archive.migration.upload.begin"
				? { ok: true, transferId: "transfer-A" }
				: op === "upload.finish"
					? json({
							id: prepared.id,
							state: "uploading",
							bytes: 3,
							sha256: "b".repeat(64),
						})
					: { ok: true },
	);
	const api = await bound(h);
	await api.reserve(input);
	await expect(api.upload(prepared, new Blob(["ab"]))).rejects.toMatchObject({
		uncertain: false,
	});
	await expect(api.upload(prepared, new Blob(["abc"]))).rejects.toMatchObject({
		uncertain: true,
	});
	await expect(api.finalize(prepared)).rejects.toMatchObject({
		code: "migration-reconciliation-required",
	});
});

test("thumbnail streams and finalize receipts preserve prepared identities", async () => {
	const h = harness(async (op) => {
		if (op === "archive.migration.reserve") return json(reservation);
		if (op === "archive.migration.upload.begin")
			return { ok: true, transferId: "thumbnail-A" };
		if (op === "upload.finish")
			return json({
				id: prepared.id,
				state: "uploading",
				bytes: 2,
				sha256: hash,
			});
		if (op === "attachment.finalize")
			return json({
				id: prepared.id,
				state: "committed",
				bytes: 3,
				sha256: hash,
			});
		return { ok: true };
	});
	const api = await bound(h);
	await api.reserve(input);
	await api.thumbnail(prepared, new Blob(["ab"]));
	await api.finalize(prepared);
	expect(h.call).toHaveBeenCalledWith(
		"archive.migration.upload.begin",
		expect.objectContaining({
			thumbnail: true,
			targetAttachmentId: prepared.id,
		}),
	);
	expect(h.call).toHaveBeenCalledWith("attachment.finalize", {
		id: prepared.id,
	});
});
test("lost finalize and recovery replies fence later mutations without implicit retries", async () => {
	for (const operation of [
		"attachment.finalize",
		"archive.migration.recover",
	] as const) {
		const h = harness(async (op) => {
			if (op === "archive.migration.reserve") return json(reservation);
			if (op === operation) throw Error("lost");
			return { ok: true };
		});
		const api = await bound(h);
		await api.reserve(input);
		const pending =
			operation === "attachment.finalize"
				? api.finalize(prepared)
				: api.recover(
						{
							ordinal: 0,
							sourceFingerprint: hash,
							previous: {
								associationId: reservation.associationId,
								attemptId: reservation.attemptId,
								targetAttachmentId: prepared.id,
								revision: 1,
							},
							prepared: {
								...prepared,
								id: "migration_22345678-1234-4123-8123-123456789abc",
							},
							retireLive: true,
						},
						expected,
					);
		await expect(pending).rejects.toMatchObject({ uncertain: true });
		await expect(api.abort(prepared.id)).rejects.toMatchObject({
			code: "migration-reconciliation-required",
		});
		expect(h.call.mock.calls.filter(([op]) => op === operation)).toHaveLength(
			1,
		);
	}
});
test("native status rejects incoherent authoritative upload witness", async () => {
	const h = harness(async (op) =>
		op === "archive.migration.reserve"
			? json(reservation)
			: json({
					...reservation,
					committed: true,
					upload: {
						declaredBytes: 3,
						ciphertextSha256: hash,
						thumbnailDeclaredBytes: null,
						thumbnailCiphertextSha256: null,
					},
				}),
	);
	const api = await bound(h);
	await api.reserve(input);
	await expect(api.status(0, reservation)).rejects.toThrow();
});

test("inspection before an aborted completion-only mutation settles cannot release its fence", async () => {
	let resolve!: (value: Awaited<ReturnType<typeof callAttachment>>) => void;
	const h = harness(async (op) =>
		op === "archive.migration.reserve"
			? new Promise((r) => {
					resolve = r;
				})
			: op === "archive.migration.inspect"
				? json(inspection)
				: { ok: true },
	);
	const api = await bound(h);
	const abort = new AbortController();
	const pending = api.reserve(input, abort.signal);
	abort.abort();
	await expect(pending).rejects.toMatchObject({ uncertain: true });
	await api.inspect(0, expected);
	await expect(api.finalize(prepared)).rejects.toMatchObject({
		code: "migration-reconciliation-required",
	});
	resolve(json(reservation));
	await new Promise((r) => setTimeout(r, 0));
	await api.inspect(0, expected);
	await expect(api.abort(prepared.id)).rejects.toMatchObject({
		uncertain: true,
	});
	expect(h.call).toHaveBeenCalledWith("attachment.abort", { id: prepared.id });
});

test("another retained ordinal cannot reconcile an uncertain target", async () => {
	const other = {
		...prepared,
		id: "migration_22345678-1234-4123-8123-123456789abc",
	};
	const otherReservation = {
		...reservation,
		targetAttachmentId: other.id,
		associationId: "22345678-1234-4123-8123-123456789abc",
	};
	const h = harness(async (op, body) => {
		if (op === "archive.migration.reserve") return json(otherReservation);
		if (op === "attachment.finalize") throw Error("lost");
		if (op === "archive.migration.inspect")
			return json(
				body?.ordinal === 1
					? { ...inspection, ...otherReservation }
					: inspection,
			);
		if (op === "archive.migration.status")
			return json({
				...otherReservation,
				upload: {
					declaredBytes: 3,
					ciphertextSha256: hash,
					thumbnailDeclaredBytes: 2,
					thumbnailCiphertextSha256: hash,
				},
			});
		return { ok: true };
	});
	const api = await bound(h);
	await api.inspect(0, expected);
	await api.reserve({ ...input, ordinal: 1, prepared: other });
	await expect(api.finalize(prepared)).rejects.toMatchObject({
		uncertain: true,
	});
	await api.inspect(1, expected);
	await api.status(1, otherReservation);
	const calls = h.call.mock.calls.length;
	await expect(api.abort(other.id)).rejects.toMatchObject({
		code: "migration-reconciliation-required",
	});
	expect(h.call).toHaveBeenCalledTimes(calls);
	await api.inspect(0, expected);
	await expect(api.abort(prepared.id)).rejects.toMatchObject({
		uncertain: true,
	});
	expect(h.call).toHaveBeenCalledWith("attachment.abort", { id: prepared.id });
});
test("foreign finalize and abort never dispatch native host operations", async () => {
	const h = harness();
	const api = await bound(h);
	const calls = h.call.mock.calls.length;
	await expect(api.finalize(prepared)).rejects.toMatchObject({
		code: "migration-binding-mismatch",
		uncertain: false,
	});
	await expect(api.abort(prepared.id)).rejects.toMatchObject({
		code: "migration-binding-mismatch",
		uncertain: false,
	});
	expect(h.call).toHaveBeenCalledTimes(calls);
	await api.reserve(input);
	const reservedCalls = h.call.mock.calls.length;
	await expect(
		api.finalize({ ...prepared, ciphertextSha256: "b".repeat(64) }),
	).rejects.toMatchObject({ code: "migration-binding-mismatch" });
	expect(h.call).toHaveBeenCalledTimes(reservedCalls);
});

test("a reconciliation read begun before the uncertain mutation cannot clear its newer fence", async () => {
	let resolve!: (value: Awaited<ReturnType<typeof callAttachment>>) => void;
	const h = harness(async (op) => {
		if (op === "archive.migration.reserve") return json(reservation);
		if (op === "archive.migration.status")
			return new Promise((r) => {
				resolve = r;
			});
		if (op === "attachment.finalize") throw Error("lost");
		return { ok: true };
	});
	const api = await bound(h);
	await api.reserve(input);
	const reading = api.status(0, reservation);
	await expect(api.finalize(prepared)).rejects.toMatchObject({
		uncertain: true,
	});
	resolve(
		json({
			...reservation,
			upload: {
				declaredBytes: 3,
				ciphertextSha256: hash,
				thumbnailDeclaredBytes: 2,
				thumbnailCiphertextSha256: hash,
			},
		}),
	);
	await reading;
	const calls = h.call.mock.calls.length;
	await expect(api.abort(prepared.id)).rejects.toMatchObject({
		code: "migration-reconciliation-required",
	});
	expect(h.call).toHaveBeenCalledTimes(calls);
});
