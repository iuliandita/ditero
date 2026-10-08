import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAttachmentRuntime } from "../../../../apps/android/src/attachment-runtime.ts";
import type { callAttachment } from "../../../../apps/android/src/bridge.ts";
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
import {
	type MigrationReservation,
	MigrationTransportError,
} from "./attachment-migration-api.ts";
import type { KeyringContextValue } from "./KeyringProvider.tsx";
import { browserE2eRuntime, type E2eRuntime } from "./runtime.ts";

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
const reservation: MigrationReservation = {
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
		kind: "list" as const,
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
const committed: MigrationReservation = {
	...reservation,
	committed: true,
	committedAt: "2026-10-06T00:00:00.000Z",
	attachmentState: "committed",
};
let zero: { userID: string };
let locked: boolean;
let wdk: Uint8Array;
let currentRuntime: E2eRuntime;
function controller(
	checkpoint: () => void = () => {},
	runtime: E2eRuntime = browserE2eRuntime,
) {
	zero = { userID: "destination-owner" };
	currentRuntime = runtime;
	locked = false;
	wdk = new Uint8Array(32).fill(7);
	const workspaceKey = vi.fn().mockResolvedValue({
		workspaceId: "destination-workspace",
		keyVersion: 1,
		wdk,
	});
	const keys = (): KeyringContextValue => ({
		runtime: currentRuntime,
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
	mock.fetcher.mockResolvedValueOnce(
		Response.json({ code: "migration-not-found" }, { status: 404 }),
	);
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
		const sent = mock.fetcher.mock.calls.slice(2);
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
		expect(mock.fetcher).toHaveBeenCalledTimes(5);
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
		const first = mock.fetcher.mock.calls[2][1].body;
		mock.fetcher
			.mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
			.mockResolvedValueOnce(Response.json(reservation))
			.mockResolvedValueOnce(Response.json(receipt()))
			.mockResolvedValueOnce(Response.json(receipt("committed")))
			.mockResolvedValueOnce(Response.json(committed));
		await c.retry();
		expect(mock.fetcher.mock.calls[4][1].body).toBe(first);
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
		expect(mock.fetcher).toHaveBeenCalledTimes(3);
		await expect(c.retry()).rejects.toMatchObject({ code: "retired" });
		expect(mock.fetcher).toHaveBeenCalledTimes(3);
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
		expect(mock.fetcher).toHaveBeenCalledTimes(2);
		locked = false;
		c.cancel();
		expect(c.state.stage).toBe("retired");
		await expect(c.transfer()).rejects.toBeDefined();
		expect(mock.fetcher).toHaveBeenCalledTimes(2);
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

const rich = (
	value: MigrationReservation = reservation,
	recoverable = false,
) => ({
	...value,
	...binding,
	sourceFingerprint: hash,
	destinationParent: parent.destinationParent,
	reservationExpiresAt: "2026-10-06T01:00:00.000Z",
	recoverable,
});
async function selectedController() {
	const c = controller();
	mock.fetcher.mockResolvedValueOnce(
		Response.json({ ...binding, items: [parent], nextAfterOrdinal: null }),
	);
	await c.open("archive", document, "passphrase");
	await c.discoverPage({ afterOrdinal: -1, limit: 64 });
	c.select(0);
	return c;
}
it("reopened archive discovers durable completion without encrypting or duplicating content", async () => {
	const c = await selectedController();
	mock.fetcher.mockResolvedValueOnce(Response.json(rich(committed)));
	await c.inspect();
	expect(c.state.stage).toBe("complete");
	expect(mock.prepare).not.toHaveBeenCalled();
	expect(mock.fetcher.mock.calls.every((call) => !call[1].method)).toBe(true);
});
it("requires confirmation before abandoning a live captured transfer", async () => {
	const c = await selectedController();
	mock.fetcher
		.mockResolvedValueOnce(Response.json(rich()))
		.mockResolvedValueOnce(Response.json(rich()));
	await c.inspect();
	await expect(c.recover({ retireLive: false })).rejects.toMatchObject({
		code: "live-abandon-confirmation-required",
	});
	expect(mock.prepare).not.toHaveBeenCalled();
});
it("lost replacement response preserves exact frozen request and inspects before replay", async () => {
	const c = await selectedController();
	const old: MigrationReservation = {
		...reservation,
		attachmentState: "aborted",
		targetAttachmentId: "migration_12345678-1234-4123-8123-123456789abf",
	};
	const next = {
		...reservation,
		revision: 2,
		attemptId: "12345678-1234-4123-8123-123456789abe",
	};
	mock.fetcher
		.mockResolvedValueOnce(Response.json(rich(old, true)))
		.mockResolvedValueOnce(Response.json(rich(old, true)))
		.mockResolvedValueOnce(Response.json(rich(old, true)))
		.mockRejectedValueOnce(Error("lost"));
	await c.inspect();
	await expect(c.recover({ retireLive: false })).rejects.toBeDefined();
	const first = mock.fetcher.mock.calls[4][1].body;
	expect(c.state.stage).toBe("uncertain");
	mock.fetcher
		.mockResolvedValueOnce(Response.json(rich(old, true)))
		.mockResolvedValueOnce(
			Response.json({ outcome: "reserved", status: rich(next) }),
		)
		.mockResolvedValueOnce(Response.json(receipt()))
		.mockResolvedValueOnce(Response.json(receipt("committed")))
		.mockResolvedValueOnce(
			Response.json({
				...next,
				committed: true,
				committedAt: committed.committedAt,
				attachmentState: "committed",
			}),
		);
	await c.retry();
	expect(mock.fetcher.mock.calls[5][0]).toContain("/attachment-migrations?");
	expect(mock.fetcher.mock.calls[6][1].body).toBe(first);
	expect(mock.prepare).toHaveBeenCalledOnce();
	expect(c.state.stage).toBe("complete");
});
it("rejects rich inspection destination drift before recovery encryption", async () => {
	const c = await selectedController();
	mock.fetcher.mockResolvedValueOnce(Response.json(rich()));
	await c.inspect();
	mock.fetcher.mockResolvedValueOnce(
		Response.json({
			...rich(),
			destinationParent: { ...parent.destinationParent, id: "other-list" },
		}),
	);
	await expect(c.recover({ retireLive: true })).rejects.toMatchObject({
		code: "migration-binding-mismatch",
	});
	expect(mock.prepare).not.toHaveBeenCalled();
});
it("key retirement erases captured recovery and archive metadata permanently", async () => {
	const c = await selectedController();
	mock.fetcher.mockResolvedValueOnce(Response.json(rich()));
	await c.inspect();
	locked = true;
	await expect(c.recover({ retireLive: true })).rejects.toMatchObject({
		code: "locked",
	});
	expect(c.state.inspection).toBeNull();
	expect(c.state.reservation).toBeNull();
	expect(c.archiveSourceIds).toEqual([]);
	locked = false;
	await expect(c.inspect()).rejects.toMatchObject({ code: "retired" });
});

it("refuses a changed live witness after replacement confirmation", async () => {
	const c = await selectedController();
	mock.fetcher
		.mockResolvedValueOnce(Response.json(rich()))
		.mockResolvedValueOnce(
			Response.json(
				rich({
					...reservation,
					attemptId: "12345678-1234-4123-8123-123456789abe",
				}),
			),
		);
	await c.inspect();
	await expect(c.recover({ retireLive: true })).rejects.toMatchObject({
		code: "reservation-identity-mismatch",
	});
	expect(mock.prepare).not.toHaveBeenCalled();
});

it.each([
	"lost",
	"cancel",
])("rechecks a %s initial inspection without preparation or mutation", async (mode) => {
	const c = await selectedController();
	if (mode === "cancel") {
		let reached!: () => void;
		const fetching = new Promise<void>((resolve) => {
			reached = resolve;
		});
		mock.fetcher.mockImplementationOnce(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(Error("cancelled")),
						{ once: true },
					);
					reached();
				}),
		);
		const pending = c.inspect();
		await fetching;
		c.cancel();
		await expect(pending).rejects.toBeDefined();
		expect(c.state.stage).toBe("cancelled");
	} else {
		mock.fetcher.mockRejectedValueOnce(Error("lost inspection"));
		await expect(c.inspect()).rejects.toBeDefined();
		expect(c.state.stage).toBe("error");
	}
	expect(c.hasPrepared).toBe(false);
	expect(c.state.ordinal).toBe(0);
	await expect(c.retry()).rejects.toMatchObject({
		code: "preparation-required",
	});
	mock.fetcher.mockResolvedValueOnce(Response.json(rich(committed)));
	await c.reconcile();
	expect(c.state.stage).toBe("complete");
	expect(c.hasPrepared).toBe(false);
	expect(mock.prepare).not.toHaveBeenCalled();
	expect(mock.fetcher.mock.calls.every((call) => !call[1].method)).toBe(true);
});
it("pre-encryption recovery inspection can be explicitly rechecked without allocating", async () => {
	const c = await selectedController();
	mock.fetcher
		.mockResolvedValueOnce(Response.json(rich()))
		.mockRejectedValueOnce(Error("lost reinspection"));
	await c.inspect();
	await expect(c.recover({ retireLive: true })).rejects.toBeDefined();
	expect(c.state.inspection).not.toBeNull();
	expect(c.hasPrepared).toBe(false);
	await expect(c.retry()).rejects.toMatchObject({
		code: "preparation-required",
	});
	mock.fetcher.mockResolvedValueOnce(Response.json(rich(committed)));
	await c.reconcile();
	expect(c.state.stage).toBe("complete");
	expect(mock.prepare).not.toHaveBeenCalled();
	expect(mock.fetcher.mock.calls.every((call) => !call[1].method)).toBe(true);
});
async function terminalReplacement() {
	const c = await selectedController();
	const original: MigrationReservation = {
		...reservation,
		targetAttachmentId: "migration_12345678-1234-4123-8123-123456789abf",
		attachmentState: "aborted",
	};
	const terminal: MigrationReservation = {
		...reservation,
		revision: 2,
		attemptId: "12345678-1234-4123-8123-123456789abe",
		attachmentState: null,
	};
	mock.fetcher
		.mockResolvedValueOnce(Response.json(rich(original, true)))
		.mockResolvedValueOnce(Response.json(rich(original, true)))
		.mockResolvedValueOnce(Response.json(rich(original, true)))
		.mockResolvedValueOnce(
			Response.json({
				outcome: "recovery-required",
				status: rich(terminal, true),
			}),
		);
	await c.inspect();
	await expect(c.recover({ retireLive: false })).rejects.toMatchObject({
		code: "recovery-required",
	});
	expect(c.state.stage).toBe("recovery-required");
	expect(c.hasPrepared).toBe(true);
	expect(mock.prepare).toHaveBeenCalledOnce();
	return { c, terminal };
}
it("explicitly replaces an exact terminal replacement with a fresh revision three attempt", async () => {
	const { c, terminal } = await terminalReplacement();
	const fresh = {
		...prepared,
		id: "migration_12345678-1234-4123-8123-123456789ab9",
	};
	const third: MigrationReservation = {
		...reservation,
		revision: 3,
		attemptId: "12345678-1234-4123-8123-123456789ab8",
		targetAttachmentId: fresh.id,
	};
	mock.prepare.mockResolvedValueOnce({
		prepared: fresh,
		parent: {
			workspaceId: "destination-workspace",
			parentKind: "list",
			parentId: "destination-list",
		},
		content: new Uint8Array([1, 2, 3]),
		thumbnail: null,
	});
	const thirdReceipt = (state: string) => ({ ...receipt(state), id: fresh.id });
	mock.fetcher
		.mockResolvedValueOnce(Response.json(rich(terminal, true)))
		.mockResolvedValueOnce(Response.json(rich(terminal, true)))
		.mockResolvedValueOnce(
			Response.json({ outcome: "reserved", status: rich(third) }),
		)
		.mockResolvedValueOnce(Response.json(thirdReceipt("uploading")))
		.mockResolvedValueOnce(Response.json(thirdReceipt("committed")))
		.mockResolvedValueOnce(
			Response.json({
				...third,
				committed: true,
				committedAt: committed.committedAt,
				attachmentState: "committed",
			}),
		);
	await c.recover({ retireLive: false });
	expect(c.state.stage).toBe("complete");
	expect(mock.prepare).toHaveBeenCalledTimes(2);
	const writes = mock.fetcher.mock.calls.filter((call) =>
		String(call[0]).endsWith("/attachment-recoveries"),
	);
	expect(writes).toHaveLength(2);
	const second = JSON.parse(writes[1][1].body);
	expect(second.previous).toEqual({
		associationId: terminal.associationId,
		attemptId: terminal.attemptId,
		targetAttachmentId: terminal.targetAttachmentId,
		revision: 2,
	});
	expect(second.prepared.id).toBe(fresh.id);
	expect(second.prepared.id).not.toBe(
		JSON.parse(writes[0][1].body).prepared.id,
	);
});
it("preserves a terminal replacement request when the confirmed witness changes", async () => {
	const { c, terminal } = await terminalReplacement();
	mock.fetcher.mockResolvedValueOnce(
		Response.json(
			rich(
				{ ...terminal, attemptId: "12345678-1234-4123-8123-123456789ab8" },
				true,
			),
		),
	);
	await expect(c.recover({ retireLive: false })).rejects.toMatchObject({
		code: "reservation-identity-mismatch",
	});
	expect(c.hasPrepared).toBe(true);
	expect(mock.prepare).toHaveBeenCalledOnce();
	expect(
		mock.fetcher.mock.calls.filter((call) =>
			String(call[0]).endsWith("/attachment-recoveries"),
		),
	).toHaveLength(1);
});

it("does not adopt a repeatedly changed attempt or clear its frozen terminal replacement", async () => {
	const { c, terminal } = await terminalReplacement();
	const changed = rich(
		{ ...terminal, attemptId: "12345678-1234-4123-8123-123456789ab8" },
		true,
	);
	mock.fetcher
		.mockResolvedValueOnce(Response.json(changed))
		.mockResolvedValueOnce(Response.json(changed));
	await expect(c.recover({ retireLive: false })).rejects.toMatchObject({
		code: "reservation-identity-mismatch",
	});
	await expect(c.recover({ retireLive: false })).rejects.toMatchObject({
		code: "retry-required",
	});
	expect(c.hasPrepared).toBe(true);
	expect(mock.prepare).toHaveBeenCalledOnce();
	expect(
		mock.fetcher.mock.calls.filter((call) =>
			String(call[0]).endsWith("/attachment-recoveries"),
		),
	).toHaveLength(1);
});
it("does not clear a frozen replacement while fresh inspection reports an active transfer", async () => {
	const { c, terminal } = await terminalReplacement();
	mock.fetcher.mockResolvedValueOnce(
		Response.json(rich({ ...terminal, attachmentState: "uploading" })),
	);
	await expect(c.recover({ retireLive: true })).rejects.toMatchObject({
		code: "retry-required",
	});
	expect(c.hasPrepared).toBe(true);
	expect(mock.prepare).toHaveBeenCalledOnce();
	expect(
		mock.fetcher.mock.calls.filter((call) =>
			String(call[0]).endsWith("/attachment-recoveries"),
		),
	).toHaveLength(1);
});

it("archive input capability alone cannot enable native attachment import", async () => {
	const readDocument = vi.fn(async () => ({
		text: document,
		name: "content.json",
	}));
	const runtime: E2eRuntime = {
		...browserE2eRuntime,
		attachments: {
			fetcher: mock.fetcher,
			pickFile: vi.fn(),
			withStage: vi.fn(),
			archiveInput: { readDocument },
		},
	};
	const c = controller(() => {}, runtime);
	await expect(c.open("archive", document, "passphrase")).rejects.toMatchObject(
		{ code: "native-unavailable" },
	);
	expect(mock.fetcher).not.toHaveBeenCalled();
	expect(mock.prepare).not.toHaveBeenCalled();
	expect(readDocument).not.toHaveBeenCalled();
});

function nativeImport() {
	type Api = ReturnType<
		typeof import("./attachment-migration-api.ts").createAttachmentMigrationApi
	>;
	const api: Api = {
		parents: vi.fn<Api["parents"]>().mockResolvedValue({
			...binding,
			items: [parent],
			nextAfterOrdinal: null,
		}),
		inspect: vi.fn<Api["inspect"]>(),
		status: vi.fn<Api["status"]>().mockResolvedValue(committed),
		reserve: vi.fn<Api["reserve"]>().mockResolvedValue(reservation),
		upload: vi
			.fn<Api["upload"]>()
			.mockResolvedValue({ ...receipt(), state: "uploading" }),
		thumbnail: vi.fn<Api["thumbnail"]>(),
		finalize: vi
			.fn<Api["finalize"]>()
			.mockResolvedValue({ ...receipt("committed"), state: "committed" }),
		abort: vi.fn<Api["abort"]>(),
		recover: vi.fn<Api["recover"]>(),
	};
	vi.mocked(api.inspect).mockRejectedValue(
		new MigrationTransportError("migration-not-found", 404, false),
	);
	let admitted = false;
	const jobs = vi.fn(async (_query: { limit: number }) => {
		admitted = true;
		return {
			items: [{ ...binding, label: "Completed import" }],
			nextAfterJobId: null,
		};
	});
	const bind = vi.fn((value: typeof binding) => {
		if (!admitted || value !== binding)
			throw new MigrationTransportError(
				"migration-binding-mismatch",
				null,
				false,
			);
		return api;
	});
	const runtime = {
		...browserE2eRuntime,
		attachments: {
			fetcher: vi.fn(),
			pickFile: vi.fn(),
			withStage: vi.fn(),
			archiveInput: { readDocument: vi.fn() },
			archiveMigration: { jobs, bind },
		},
	};
	return { api, runtime, jobs, bind };
}

async function readyNative(h: ReturnType<typeof nativeImport>) {
	await h.jobs({ limit: 64 });
	const c = controller(() => {}, h.runtime);
	await c.open("archive", document, "passphrase");
	await c.discoverPage({ afterOrdinal: -1, limit: 64 });
	c.select(0);
	await c.prepare();
	return c;
}

it("uses only a jobs-admitted native binding for encrypted transfer and acknowledgment", async () => {
	const h = nativeImport();
	const c = await readyNative(h);
	await c.transfer();
	expect(c.state.stage).toBe("complete");
	expect(h.jobs.mock.invocationCallOrder[0]).toBeLessThan(
		h.bind.mock.invocationCallOrder[0],
	);
	expect(h.bind).toHaveBeenCalledExactlyOnceWith(binding);
	expect(h.api.reserve).toHaveBeenCalledOnce();
	expect(h.api.upload).toHaveBeenCalledWith(
		prepared,
		expect.any(Blob),
		expect.any(AbortSignal),
	);
	expect(h.api.status).toHaveBeenCalledOnce();
	expect(mock.fetcher).not.toHaveBeenCalled();
	expect(wdk).toEqual(new Uint8Array(32).fill(7));
});

it("refuses an unadmitted native job without browser fallback", async () => {
	const h = nativeImport();
	const c = controller(() => {}, h.runtime);
	await c.open("archive", document, "passphrase");
	await expect(
		c.discoverPage({ afterOrdinal: -1, limit: 64 }),
	).rejects.toMatchObject({ code: "migration-binding-mismatch" });
	expect(h.api.parents).not.toHaveBeenCalled();
	expect(mock.fetcher).not.toHaveBeenCalled();
});

it("reconciles native lost-finalize acknowledgment without replaying encrypted upload", async () => {
	const h = nativeImport();
	const c = await readyNative(h);
	vi.mocked(h.api.finalize).mockRejectedValueOnce(
		new MigrationTransportError("response-lost", null, true),
	);
	await expect(c.transfer()).rejects.toMatchObject({ code: "response-lost" });
	expect(c.state.stage).toBe("uncertain");
	await c.reconcile();
	expect(c.state.stage).toBe("complete");
	expect(h.api.upload).toHaveBeenCalledOnce();
	expect(h.api.abort).not.toHaveBeenCalled();
	expect(mock.fetcher).not.toHaveBeenCalled();
});

it.each([
	"lock",
	"runtime",
	"owner",
])("retires native preparation on %s loss without transport", async (loss) => {
	const h = nativeImport();
	const c = await readyNative(h);
	if (loss === "lock") locked = true;
	else if (loss === "runtime") currentRuntime = { ...h.runtime };
	else zero.userID = "next-owner";
	await expect(c.transfer()).rejects.toMatchObject({
		code:
			loss === "lock"
				? "locked"
				: loss === "runtime"
					? "native-unavailable"
					: "retired",
	});
	expect(c.state.stage).toBe("retired");
	expect(c.hasPrepared).toBe(false);
	expect(h.api.reserve).not.toHaveBeenCalled();
	expect(mock.fetcher).not.toHaveBeenCalled();
});

it.each([
	"migration-only",
	"neither",
	"foreign-browser",
])("refuses %s native capabilities without binding or cookie fetch", async (caps) => {
	const h = nativeImport();
	const runtime: E2eRuntime =
		caps === "foreign-browser"
			? { ...browserE2eRuntime }
			: {
					...h.runtime,
					attachments:
						caps === "neither"
							? { fetcher: vi.fn(), pickFile: vi.fn(), withStage: vi.fn() }
							: { ...h.runtime.attachments, archiveInput: undefined },
				};
	const c = controller(() => {}, runtime);
	await expect(c.open("archive", document, "passphrase")).rejects.toMatchObject(
		{ code: "native-unavailable" },
	);
	expect(h.bind).not.toHaveBeenCalled();
	expect(mock.open).not.toHaveBeenCalled();
	expect(mock.fetcher).not.toHaveBeenCalled();
});

async function realNativeReserve(
	options: {
		inspection?: Partial<MigrationReservation> | "missing";
		pending?: boolean;
	} = {},
) {
	let dispatched = false;
	let finalized = false;
	let settleReserve!: (
		reply: Awaited<ReturnType<typeof callAttachment>>,
	) => void;
	const reserveReply = new Promise<Awaited<ReturnType<typeof callAttachment>>>(
		(resolve) => {
			settleReserve = resolve;
		},
	);
	const json = (body: unknown, status = 200) => ({
		ok: status < 300,
		status,
		body: JSON.stringify(body),
	});
	const call = vi.fn<typeof callAttachment>(async (op) => {
		if (op === "archive.migration.jobs")
			return json({
				items: [{ ...binding, label: "Completed import" }],
				nextAfterJobId: null,
			});
		if (op === "archive.migration.parents")
			return json({ ...binding, items: [parent], nextAfterOrdinal: null });
		if (op === "archive.migration.reserve") {
			dispatched = true;
			if (options.pending) return reserveReply;
			throw Error("lost reserve reply");
		}
		if (op === "archive.migration.inspect") {
			if (!dispatched || options.inspection === "missing")
				return json({ code: "migration-not-found" }, 404);
			return json({
				...reservation,
				...binding,
				sourceFingerprint: hash,
				destinationParent: parent.destinationParent,
				reservationExpiresAt: "2026-10-08T12:00:00Z",
				recoverable: false,
				...options.inspection,
			});
		}
		if (op === "archive.migration.status")
			return json({
				...(finalized ? committed : reservation),
				upload: finalized
					? null
					: {
							declaredBytes: 3,
							ciphertextSha256: hash,
							thumbnailDeclaredBytes: null,
							thumbnailCiphertextSha256: null,
						},
			});
		if (op === "archive.migration.upload.begin")
			return { ok: true, transferId: "actual-native-transfer" };
		if (op === "upload.finish") return json(receipt());
		if (op === "attachment.finalize") {
			finalized = true;
			return json(receipt("committed"));
		}
		if (op === "upload.write" || op === "attachment.cancel")
			return { ok: true };
		throw Error(`Unexpected native operation: ${op}`);
	});
	const attachments = createAttachmentRuntime(
		() => {},
		"captured-native-scope",
		true,
		call,
		false,
		true,
		true,
		binding.ownerId,
	);
	if (!attachments.archiveMigration) throw Error("Native migration missing");
	await attachments.archiveMigration.jobs({ limit: 64 });
	const c = controller(() => {}, { ...browserE2eRuntime, attachments });
	await c.open("archive", document, "passphrase");
	await c.discoverPage({ afterOrdinal: -1, limit: 64 });
	c.select(0);
	await c.prepare();
	return { c, call, settle: () => settleReserve(json(reservation)) };
}

it("real native adapter reconciles lost reserve before reusing the exact preparation", async () => {
	const { c, call } = await realNativeReserve();
	await expect(c.transfer()).rejects.toMatchObject({ uncertain: true });
	expect(c.state.stage).toBe("uncertain");
	await c.retry();
	expect(c.state.stage).toBe("complete");
	expect(mock.prepare).toHaveBeenCalledOnce();
	expect(
		call.mock.calls.filter(([op]) => op === "archive.migration.reserve"),
	).toHaveLength(1);
	expect(
		call.mock.calls.filter(([op]) => op === "archive.migration.upload.begin"),
	).toHaveLength(1);
	expect(call).toHaveBeenCalledWith(
		"archive.migration.upload.begin",
		expect.objectContaining({
			targetAttachmentId: prepared.id,
			revision: 1,
			attemptId: reservation.attemptId,
		}),
	);
	expect(
		call.mock.calls.some(([op]) => op === "archive.migration.recover"),
	).toBe(false);
	expect(mock.fetcher).not.toHaveBeenCalled();
});

it.each([
	{ targetAttachmentId: "migration_12345678-1234-4123-8123-123456789ab9" },
	{ revision: 2 },
])("real native adapter refuses a changed lost-reserve witness %j", async (inspection) => {
	const { c, call } = await realNativeReserve({ inspection });
	await expect(c.transfer()).rejects.toMatchObject({ uncertain: true });
	await expect(c.retry()).rejects.toMatchObject({
		code: "reservation-identity-mismatch",
	});
	expect(
		call.mock.calls.filter(([op]) => op === "archive.migration.reserve"),
	).toHaveLength(1);
	expect(
		call.mock.calls.some(
			([op]) =>
				op === "archive.migration.upload.begin" ||
				op === "archive.migration.recover",
		),
	).toBe(false);
	expect(mock.prepare).toHaveBeenCalledOnce();
	expect(mock.fetcher).not.toHaveBeenCalled();
});

it("real native adapter keeps missing lost-reserve inspection uncertain without another reserve", async () => {
	const { c, call } = await realNativeReserve({ inspection: "missing" });
	await expect(c.transfer()).rejects.toMatchObject({ uncertain: true });
	await expect(c.retry()).rejects.toMatchObject({
		code: "migration-reconciliation-required",
		uncertain: true,
	});
	expect(c.state.stage).toBe("uncertain");
	expect(
		call.mock.calls.filter(([op]) => op === "archive.migration.reserve"),
	).toHaveLength(1);
	expect(
		call.mock.calls.some(
			([op]) =>
				op === "archive.migration.upload.begin" ||
				op === "archive.migration.recover",
		),
	).toBe(false);
	expect(mock.fetcher).not.toHaveBeenCalled();
});

it("real native adapter preserves the pending-reserve fence until original settlement", async () => {
	const { c, call, settle } = await realNativeReserve({ pending: true });
	const transfer = c.transfer();
	const rejected = expect(transfer).rejects.toMatchObject({ uncertain: true });
	await vi.waitFor(() =>
		expect(
			call.mock.calls.some(([op]) => op === "archive.migration.reserve"),
		).toBe(true),
	);
	c.cancel();
	await rejected;
	await expect(c.retry()).rejects.toMatchObject({
		code: "migration-reconciliation-required",
	});
	expect(
		call.mock.calls.some(([op]) => op === "archive.migration.upload.begin"),
	).toBe(false);
	settle();
	await c.reconcile();
	await c.retry();
	expect(c.state.stage).toBe("complete");
	expect(
		call.mock.calls.filter(([op]) => op === "archive.migration.reserve"),
	).toHaveLength(1);
	expect(
		call.mock.calls.filter(([op]) => op === "archive.migration.upload.begin"),
	).toHaveLength(1);
	expect(mock.fetcher).not.toHaveBeenCalled();
});
