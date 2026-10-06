import { beforeEach, describe, expect, it, vi } from "vitest";
import { aad, encryptWrapped } from "../../../domain/e2e/envelope.ts";
import { encodeBytes, encodeWrapped } from "../../../domain/e2e/wire.ts";

const mock = vi.hoisted(() => ({
	fetcher: vi.fn(),
	open: vi.fn(),
	prepare: vi.fn(),
	fingerprint: vi.fn(),
}));
vi.mock("./runtime.ts", () => ({
	browserE2eRuntime: { fetcher: mock.fetcher },
}));
vi.mock("./attachment-archive.ts", () => ({
	openAttachmentArchive: mock.open,
}));
vi.mock("./attachment-migration-prepare.ts", () => ({
	prepareAttachmentMigration: mock.prepare,
}));
vi.mock("../../../domain/portability/import-digest.ts", () => ({
	hashImportValue: mock.fingerprint,
}));
vi.mock("../../../domain/portability/import-document.ts", () => ({
	parseImportDocument: (text: string) => JSON.parse(text),
}));
vi.mock("../zero-lifecycle.ts", () => ({
	isZeroClientOwnerActive: () => true,
}));

import { createAttachmentImportController } from "./attachment-import-controller.ts";
import type { KeyringContextValue } from "./KeyringProvider.tsx";
import { browserE2eRuntime } from "./runtime.ts";

const hash = "a".repeat(64);
const binding = {
	ownerId: "destination-owner",
	jobId: hash,
	sourceId: "source",
	documentDigest: hash,
	mappingDigest: hash,
	planDigest: hash,
};
const prepared = {
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
const reservation = {
	associationId: "12345678-1234-4123-8123-123456789abc",
	revision: 1,
	attemptId: "12345678-1234-4123-8123-123456789abd",
	targetAttachmentId: prepared.id,
	committed: false,
	committedAt: null,
	attachmentState: "reserved",
};
const parent = {
	ordinal: 0,
	sourceAttachmentId: "source-file",
	sourceAttachmentFingerprint: hash,
	destinationParent: {
		kind: "list",
		id: "destination-list",
		workspaceId: "destination-workspace",
	},
	blockedReason: null,
};
const document = JSON.stringify({
	sourceUserId: "different-source-owner",
	data: { attachments: [{ id: "source-file" }] },
});
const receipt = (state = "uploading") => ({
	id: prepared.id,
	state,
	bytes: 3,
	sha256: hash,
});
const committed = {
	...reservation,
	committed: true,
	committedAt: "2026-10-06T00:00:00.000Z",
	attachmentState: "committed",
};
let zero: { userID: string };
let locked: boolean;
let wdk: Uint8Array;
function controller(checkpoint: () => void = () => {}) {
	zero = { userID: "destination-owner" };
	locked = false;
	wdk = new Uint8Array(32).fill(7);
	const workspaceKey = vi.fn().mockResolvedValue({
		workspaceId: "destination-workspace",
		keyVersion: 1,
		wdk,
	});
	const keys = (): KeyringContextValue => ({
		runtime: browserE2eRuntime,
		state: locked ? "locked" : "ready",
		ready: true,
		available: true,
		identity: null,
		lockedByTimeout: false,
		unlock: vi.fn(),
		lockNow: vi.fn(),
		signOut: vi.fn(),
		adoptPrivateKey: vi.fn(),
		refreshWorkspaceKeys: vi.fn(),
		workspaceKey,
		cacheWorkspaceKey: vi.fn(),
		privateKey: vi.fn(),
		refresh: vi.fn(),
	});
	return createAttachmentImportController({
		binding,
		ownerId: binding.ownerId,
		zero: zero as Parameters<
			typeof createAttachmentImportController
		>[0]["zero"],
		keyring: keys,
		checkpoint,
	});
}
async function ready() {
	const c = controller();
	mock.fetcher.mockResolvedValueOnce(
		Response.json({ ...binding, items: [parent], nextAfterOrdinal: null }),
	);
	await c.open("archive", document, "passphrase");
	await c.discoverPage({ afterOrdinal: -1, limit: 64 });
	c.select(0);
	await c.prepare();
	return c;
}
beforeEach(() => {
	vi.resetAllMocks();
	mock.open.mockResolvedValue({
		manifest: {
			entries: [{ entryId: "entry", source: { id: "source-file" } }],
		},
		archive: {},
	});
	mock.fingerprint.mockResolvedValue(hash);
	mock.prepare.mockImplementation(async () =>
		Object.freeze({
			prepared: Object.freeze({ ...prepared }),
			parent: {
				workspaceId: "destination-workspace",
				parentKind: "list",
				parentId: "destination-list",
			},
			get content() {
				return new Uint8Array([1, 2, 3]);
			},
			get thumbnail() {
				return null;
			},
		}),
	);
});
describe("attachment import controller", () => {
	it("transfers a different-account archive through durable status acknowledgment", async () => {
		const c = await ready();
		mock.fetcher
			.mockResolvedValueOnce(Response.json(reservation))
			.mockResolvedValueOnce(Response.json(receipt()))
			.mockResolvedValueOnce(Response.json(receipt("committed")))
			.mockResolvedValueOnce(Response.json(committed));
		await c.transfer();
		expect(c.state.stage).toBe("complete");
		expect(mock.prepare).toHaveBeenCalledOnce();
		expect(wdk).toEqual(new Uint8Array(32).fill(7));
		const sent = mock.fetcher.mock.calls.slice(1);
		expect(sent.map((call) => call[0])).toEqual([
			`/api/portability/import/plans/${hash}/attachment-reservations`,
			`/api/attachments/${prepared.id}/upload`,
			"/api/attachments/finalize",
			`/api/portability/import/plans/${hash}/attachment-reservations?ordinal=0`,
		]);
		expect(String(sent[0][1].body)).not.toContain("passphrase");
	});
	it("does not abort or retry after lost finalize and completes from status", async () => {
		const c = await ready();
		mock.fetcher
			.mockResolvedValueOnce(Response.json(reservation))
			.mockResolvedValueOnce(Response.json(receipt()))
			.mockRejectedValueOnce(Error("lost"));
		await expect(c.transfer()).rejects.toBeDefined();
		expect(c.state.stage).toBe("uncertain");
		expect(mock.fetcher).toHaveBeenCalledTimes(4);
		mock.fetcher.mockResolvedValueOnce(Response.json(committed));
		await c.reconcile();
		expect(c.state.stage).toBe("complete");
		expect(
			mock.fetcher.mock.calls.some((call) => String(call[0]).includes("abort")),
		).toBe(false);
	});
	it("manual lost-reserve retry preserves exact preparation and ciphertext", async () => {
		const c = await ready();
		mock.fetcher.mockRejectedValueOnce(Error("lost"));
		await expect(c.transfer()).rejects.toBeDefined();
		const first = mock.fetcher.mock.calls[1][1].body;
		mock.fetcher
			.mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
			.mockResolvedValueOnce(Response.json(reservation))
			.mockResolvedValueOnce(Response.json(receipt()))
			.mockResolvedValueOnce(Response.json(receipt("committed")))
			.mockResolvedValueOnce(Response.json(committed));
		await c.retry();
		expect(mock.fetcher.mock.calls[3][1].body).toBe(first);
		expect(mock.prepare).toHaveBeenCalledOnce();
		expect(c.state.stage).toBe("complete");
	});
	it("reconciles lost upload as uploading and avoids repeating content", async () => {
		const c = await ready();
		mock.fetcher
			.mockResolvedValueOnce(Response.json(reservation))
			.mockRejectedValueOnce(Error("lost"));
		await expect(c.transfer()).rejects.toBeDefined();
		mock.fetcher
			.mockResolvedValueOnce(
				Response.json({ ...reservation, attachmentState: "uploading" }),
			)
			.mockResolvedValueOnce(Response.json(receipt("committed")))
			.mockResolvedValueOnce(Response.json(committed));
		await c.retry();
		expect(
			mock.fetcher.mock.calls.filter((call) =>
				String(call[0]).endsWith("/upload"),
			),
		).toHaveLength(1);
		expect(c.state.stage).toBe("complete");
	});
	it("refuses source fingerprint drift before preparation", async () => {
		const c = controller();
		mock.fetcher.mockResolvedValueOnce(
			Response.json({ ...binding, items: [parent], nextAfterOrdinal: null }),
		);
		await c.open("archive", document, "passphrase");
		await c.discoverPage({ afterOrdinal: -1, limit: 64 });
		c.select(0);
		mock.fingerprint.mockResolvedValue("b".repeat(64));
		await expect(c.prepare()).rejects.toMatchObject({
			code: "source-fingerprint-mismatch",
		});
		expect(mock.prepare).not.toHaveBeenCalled();
	});
	it("stops on account retirement after reservation without aborting as next account", async () => {
		const c = await ready();
		mock.fetcher.mockImplementationOnce(async () => {
			zero.userID = "other";
			return Response.json(reservation);
		});
		await expect(c.transfer()).rejects.toBeDefined();
		expect(c.state.stage).toBe("retired");
		expect(mock.fetcher).toHaveBeenCalledTimes(2);
		await expect(c.retry()).rejects.toMatchObject({ code: "retired" });
		expect(mock.fetcher).toHaveBeenCalledTimes(2);
	});
	it("requires explicit recovery for a missing previously captured target", async () => {
		const c = await ready();
		mock.fetcher
			.mockResolvedValueOnce(Response.json(reservation))
			.mockRejectedValueOnce(Error("lost"));
		await expect(c.transfer()).rejects.toBeDefined();
		mock.fetcher.mockResolvedValueOnce(
			new Response("Not Found", { status: 404 }),
		);
		await expect(c.retry()).rejects.toMatchObject({
			code: "recovery-required",
		});
		expect(c.state.stage).toBe("recovery-required");
		expect(mock.prepare).toHaveBeenCalledOnce();
	});
	it("requires explicit recovery for an aborted active attempt", async () => {
		const c = await ready();
		mock.fetcher.mockRejectedValueOnce(Error("lost"));
		await expect(c.transfer()).rejects.toBeDefined();
		mock.fetcher.mockResolvedValueOnce(
			Response.json({ ...reservation, attachmentState: "aborted" }),
		);
		await expect(c.retry()).rejects.toMatchObject({
			code: "recovery-required",
		});
		expect(mock.prepare).toHaveBeenCalledOnce();
	});
	it("rejects changed attempt identity during reconciliation", async () => {
		const c = await ready();
		mock.fetcher
			.mockResolvedValueOnce(Response.json(reservation))
			.mockRejectedValueOnce(Error("lost"));
		await expect(c.transfer()).rejects.toBeDefined();
		mock.fetcher.mockResolvedValueOnce(
			Response.json({
				...reservation,
				attemptId: "12345678-1234-4123-8123-123456789abe",
			}),
		);
		await expect(c.reconcile()).rejects.toMatchObject({
			code: "reservation-identity-mismatch",
		});
	});
	it("does not reserve after locking or cancellation before transfer", async () => {
		const c = await ready();
		locked = true;
		await expect(c.transfer()).rejects.toMatchObject({ code: "locked" });
		expect(mock.fetcher).toHaveBeenCalledOnce();
		locked = false;
		c.cancel();
		expect(c.state.stage).toBe("cancelled");
		await expect(c.transfer()).rejects.toBeDefined();
		expect(mock.fetcher).toHaveBeenCalledOnce();
	});
	it("releases archive and permanently refuses disposed ownership", async () => {
		const c = await ready();
		c.dispose();
		await expect(c.retry()).rejects.toMatchObject({ code: "retired" });
		expect(c.parents).toEqual([]);
	});
});

it("post-finalize status loss remains uncertain and cannot blindly abort", async () => {
	const c = await ready();
	mock.fetcher
		.mockResolvedValueOnce(Response.json(reservation))
		.mockResolvedValueOnce(Response.json(receipt()))
		.mockResolvedValueOnce(Response.json(receipt("committed")))
		.mockRejectedValueOnce(Error("lost status"));
	await expect(c.transfer()).rejects.toBeDefined();
	expect(c.state.stage).toBe("uncertain");
	await expect(c.cancelReservation()).rejects.toMatchObject({
		code: "reconcile-before-cancel",
	});
	expect(
		mock.fetcher.mock.calls.some((call) => String(call[0]).includes("abort")),
	).toBe(false);
});
it("manual cancellation uses captured status, confirms aborted target and never next account", async () => {
	const c = await ready();
	mock.fetcher
		.mockResolvedValueOnce(Response.json(reservation))
		.mockRejectedValueOnce(Error("lost upload"));
	await expect(c.transfer()).rejects.toBeDefined();
	c.cancel();
	mock.fetcher
		.mockResolvedValueOnce(Response.json(reservation))
		.mockResolvedValueOnce(Response.json({ id: prepared.id, state: "aborted" }))
		.mockResolvedValueOnce(
			Response.json({ ...reservation, attachmentState: "aborted" }),
		);
	await c.cancelReservation();
	expect(c.state.stage).toBe("cancelled");
	expect(
		mock.fetcher.mock.calls.filter((call) =>
			String(call[0]).endsWith("/abort"),
		),
	).toHaveLength(1);
});
it("does not erase durable completion on local cancel", async () => {
	const c = await ready();
	mock.fetcher.mockRejectedValueOnce(Error("lost reserve"));
	await expect(c.transfer()).rejects.toBeDefined();
	mock.fetcher.mockResolvedValueOnce(Response.json(committed));
	await c.reconcile();
	c.cancel();
	expect(c.state.stage).toBe("complete");
});
it("expired ordinary upload becomes explicit recovery, with no replacement", async () => {
	const c = await ready();
	mock.fetcher
		.mockResolvedValueOnce(Response.json(reservation))
		.mockResolvedValueOnce(new Response("Gone", { status: 410 }));
	await expect(c.transfer()).rejects.toBeDefined();
	expect(c.state.stage).toBe("recovery-required");
	expect(mock.prepare).toHaveBeenCalledOnce();
});

it("exposes source eligibility without keys and refuses absent archive entries before preparation", async () => {
	const c = controller();
	mock.open.mockResolvedValueOnce({
		manifest: {
			entries: [{ entryId: "other-entry", source: { id: "other-file" } }],
		},
		archive: {},
	});
	mock.fetcher.mockResolvedValueOnce(
		Response.json({ ...binding, items: [parent], nextAfterOrdinal: null }),
	);
	await c.open("archive", document, "passphrase");
	await c.discoverPage({ afterOrdinal: -1, limit: 64 });
	expect(c.archiveSourceIds).toEqual(["other-file"]);
	expect(Object.isFrozen(c.archiveSourceIds)).toBe(true);
	expect(() => c.select(0)).toThrow("archive-entry-missing");
	expect(mock.prepare).not.toHaveBeenCalled();
});

async function namedEntry(filename: Uint8Array, boundId = "source-file") {
	const dek = new Uint8Array(32).fill(9);
	try {
		return {
			entryId: "entry",
			source: {
				id: "source-file",
				filenameCiphertext: encodeWrapped(
					await encryptWrapped(
						filename,
						dek,
						aad.metadata(boundId, "filename"),
					),
				),
			},
			locallyExportedDek: encodeBytes(dek),
		};
	} finally {
		dek.fill(0);
		filename.fill(0);
	}
}
it("describes authenticated source names using real AEAD and sanitizes hostile basename", async () => {
	const entry = await namedEntry(
		new TextEncoder().encode("../report\u202E.txt"),
	);
	mock.open.mockResolvedValueOnce({
		manifest: { entries: [entry] },
		archive: {},
	});
	const c = controller();
	await c.open("archive", document, "passphrase");
	const names = await c.describeArchiveSources();
	expect(names).toEqual([{ sourceId: "source-file", filename: "report.txt" }]);
	expect(Object.isFrozen(names)).toBe(true);
	expect(Object.isFrozen(names[0])).toBe(true);
	expect(Object.keys(names[0])).toEqual(["sourceId", "filename"]);
});
it("rejects owner loss at the post-real-decryption checkpoint before exposing names", async () => {
	const entry = await namedEntry(new TextEncoder().encode("private.txt"));
	mock.open.mockResolvedValueOnce({
		manifest: { entries: [entry] },
		archive: {},
	});
	let armed = false,
		checks = 0;
	const c = controller(() => {
		if (armed && ++checks === 3) zero.userID = "different-user";
	});
	await c.open("archive", document, "passphrase");
	armed = true;
	await expect(c.describeArchiveSources()).rejects.toMatchObject({
		code: "retired",
	});
	expect(c.state.stage).toBe("retired");
	expect(mock.fetcher).not.toHaveBeenCalled();
});
it("rejects forged original filename AAD with real AEAD", async () => {
	const entry = await namedEntry(
		new TextEncoder().encode("private.txt"),
		"wrong-id",
	);
	mock.open.mockResolvedValueOnce({
		manifest: { entries: [entry] },
		archive: {},
	});
	const c = controller();
	await c.open("archive", document, "passphrase");
	await expect(c.describeArchiveSources()).rejects.toBeDefined();
});
it("rejects malformed authenticated filename UTF8", async () => {
	const entry = await namedEntry(new Uint8Array([255]));
	mock.open.mockResolvedValueOnce({
		manifest: { entries: [entry] },
		archive: {},
	});
	const c = controller();
	await c.open("archive", document, "passphrase");
	await expect(c.describeArchiveSources()).rejects.toBeDefined();
});
it("refuses describing more than the archive entry cap", async () => {
	mock.open.mockResolvedValueOnce({
		manifest: {
			entries: Array.from({ length: 65 }, () => ({ source: { id: "unused" } })),
		},
		archive: {},
	});
	const c = controller();
	await c.open("archive", document, "passphrase");
	await expect(c.describeArchiveSources()).rejects.toMatchObject({
		code: "archive-entry-limit",
	});
});
