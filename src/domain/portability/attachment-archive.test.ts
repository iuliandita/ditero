import { describe, expect, it } from "vitest";
import { encodeBytes, encodeWrapped } from "../e2e/wire.ts";
import {
	type AttachmentArchiveContract,
	type AttachmentArchiveManifestContract,
	assertAttachmentArchiveObjectBinding,
	assertAttachmentArchivePortableRowBinding,
	attachmentArchiveAad,
	parseAttachmentArchiveContract,
	parseAttachmentArchiveManifestContract,
} from "./attachment-archive.ts";
import type { PortableExportV1 } from "./v1.ts";

type Mutable<T> = T extends readonly (infer Item)[]
	? Mutable<Item>[]
	: T extends object
		? { -readonly [Key in keyof T]: Mutable<T[Key]> }
		: T;

const archiveId = "d7c195de-fd79-4598-bf09-1d542378ee55";
const entryId = "437ba766-b159-46c8-b6f1-ab0d02eb75bf";
const hash = "a".repeat(64);
const wire = (length: number) =>
	encodeWrapped({
		version: 1,
		nonce: new Uint8Array(12),
		ciphertext: new Uint8Array(length + 16),
	});
function manifestValue(): Mutable<AttachmentArchiveManifestContract> {
	return {
		archiveId,
		exportedAt: "2026-10-05T00:00:00.000Z",
		contentDocument: {
			format: "ditero",
			schemaVersion: 1,
			exactBytesSha256: hash,
			sourceUserId: "source-user",
			sourceNamespace: null,
		},
		entries: [
			{
				entryId,
				source: {
					id: "source-file",
					workspaceId: "source-workspace",
					keyVersion: 1,
					parentKind: "task",
					parentId: "source-task",
					filenameCiphertext: wire(4),
					contentTypeCiphertext: wire(4),
					dekWrapped: wire(32),
				},
				locallyExportedDek: encodeBytes(new Uint8Array(32)),
				content: { bytes: 50, sha256: hash },
				thumbnail: null,
			},
		],
	};
}
function archiveValue(): Mutable<AttachmentArchiveContract> {
	return {
		format: "ditero-attachment-archive",
		schemaVersion: 1,
		archiveId,
		unlock: { kdfVersion: 1, salt: encodeBytes(new Uint8Array(16)) },
		protectedManifest: wire(100),
		objects: [
			{ entryId, content: encodeBytes(new Uint8Array(50)), thumbnail: null },
		],
	};
}
function documentValue(): PortableExportV1 {
	return {
		format: "ditero",
		schemaVersion: 1,
		exportedAt: "2026-10-05T00:00:00.000Z",
		sourceUserId: "source-user",
		boundaries: {
			attachmentContent: "excluded",
			encryptionKeys: "excluded",
			credentials: "excluded",
			managedAccounts: "excluded",
			restoreSupported: false,
			taskHistory: "current-state-and-habit-logs",
		},
		data: {
			attachments: [
				{
					id: "source-file",
					workspaceId: "source-workspace",
					parentKind: "task",
					parentId: "source-task",
					keyVersion: 1,
					declaredBytes: 50,
					observedBytes: 50,
					ciphertextSha256: hash,
					thumbnailDeclaredBytes: null,
					thumbnailObservedBytes: null,
					thumbnailCiphertextSha256: null,
					uploadedBy: "original-uploader",
					createdAt: "2026-10-05T00:00:00.000Z",
					committedAt: "2026-10-05T00:00:00.000Z",
				},
			],
			principals: [],
			workspaces: [],
			memberships: [],
			folders: [],
			lists: [],
			tasks: [],
			labels: [],
			taskLabels: [],
			templates: [],
			assignments: [],
			comments: [],
			habitLogs: [],
			views: [],
			dashboards: [],
			userPrefs: [],
			focusSessions: [],
			karma: [],
			karmaEvents: [],
		},
	};
}
const manifest = () =>
	parseAttachmentArchiveManifestContract(JSON.stringify(manifestValue()));
const archive = () =>
	parseAttachmentArchiveContract(JSON.stringify(archiveValue()));

describe("attachment archive contract", () => {
	it("admits independently named shape, freezes copies and binds unchanged portable rows", () => {
		const parsed = archive();
		const opened = manifest();
		expect(parsed.format).toBe("ditero-attachment-archive");
		expect(Object.isFrozen(opened.entries[0]?.source)).toBe(true);
		expect(Object.isFrozen(parsed.objects)).toBe(true);
		assertAttachmentArchiveObjectBinding(parsed, opened);
		assertAttachmentArchivePortableRowBinding(opened, documentValue());
		// These all-zero ciphertext fixtures are shape-valid, not authenticated.
		expect(opened.contentDocument.exactBytesSha256).toBe(hash);
	});
	it.each([
		"__proto__",
		"constructor",
		"prototype",
		"unknown",
	])("refuses unknown/prototype field %s", (key) => {
		const value = archiveValue();
		const raw = JSON.stringify(value).replace(
			'"unlock":{',
			`"unlock":{"${key}":{},`,
		);
		expect(() => parseAttachmentArchiveContract(raw)).toThrow(
			"invalid-contract",
		);
	});
	it("refuses depth, malformed JSON, NUL and unpaired Unicode before recursive validation", () => {
		for (const raw of [
			`{"x":${"[".repeat(40)}0${"]".repeat(40)}}`,
			"{",
			JSON.stringify({ ...manifestValue(), archiveId: "\ud800" }),
			JSON.stringify({ ...manifestValue(), archiveId: "\u0000" }),
		])
			expect(() => parseAttachmentArchiveManifestContract(raw)).toThrow(
				"invalid-contract",
			);
	});
	it("bounds exact UTF-8 input before shape work and wrapped plaintext before KDF", () => {
		expect(() =>
			parseAttachmentArchiveManifestContract(JSON.stringify("é".repeat(16384))),
		).toThrow("byte-limit");
		expect(() =>
			parseAttachmentArchiveContract(" ".repeat(32 * 1024 * 1024 + 1)),
		).toThrow("byte-limit");
		const value = archiveValue();
		value.protectedManifest = wire(32768);
		expect(() =>
			parseAttachmentArchiveContract(JSON.stringify(value)),
		).not.toThrow();
		value.protectedManifest = wire(32769);
		expect(() => parseAttachmentArchiveContract(JSON.stringify(value))).toThrow(
			"invalid-contract",
		);
	});
	it("refuses noncanonical trailing bits, padding and unsupported KDF/envelope versions", () => {
		const value = archiveValue();
		value.unlock.salt = `${"A".repeat(21)}B`;
		expect(() =>
			parseAttachmentArchiveContract(JSON.stringify(value)),
		).toThrow();
		value.unlock.salt = `${encodeBytes(new Uint8Array(16))}=`;
		expect(() =>
			parseAttachmentArchiveContract(JSON.stringify(value)),
		).toThrow();
		const opened = manifestValue();
		opened.entries[0].locallyExportedDek = `${"A".repeat(42)}B`;
		expect(() =>
			parseAttachmentArchiveManifestContract(JSON.stringify(opened)),
		).toThrow();
		expect(() =>
			parseAttachmentArchiveContract(
				JSON.stringify({
					...archiveValue(),
					unlock: { ...archiveValue().unlock, kdfVersion: 2 },
				}),
			),
		).toThrow();
		value.protectedManifest = encodeBytes(
			new Uint8Array([2, ...new Uint8Array(40)]),
		);
		expect(() =>
			parseAttachmentArchiveContract(JSON.stringify(value)),
		).toThrow();
	});
	it("rejects duplicate object/source identities and excess entries", () => {
		const value = archiveValue();
		value.objects.push(value.objects[0]);
		expect(() =>
			parseAttachmentArchiveContract(JSON.stringify(value)),
		).toThrow();
		const opened = manifestValue();
		opened.entries.push({
			...opened.entries[0],
			entryId: "437ba766-b159-46c8-b6f1-ab0d02eb75ba",
		});
		expect(() =>
			parseAttachmentArchiveManifestContract(JSON.stringify(opened)),
		).toThrow();
		value.objects = Array.from({ length: 65 }, (_, index) => ({
			...value.objects[0],
			entryId: `437ba766-b159-46c8-b6f1-${index.toString(16).padStart(12, "0")}`,
		}));
		expect(() =>
			parseAttachmentArchiveContract(JSON.stringify(value)),
		).toThrow();
	});
	it("bounds decoded aggregate before allocating payload buffers", () => {
		const value = archiveValue();
		value.objects[0].content = "A".repeat(12 * 1024 * 1024); // 9MiB each
		value.objects.push({
			...value.objects[0],
			entryId: "437ba766-b159-46c8-b6f1-ab0d02eb75ba",
		});
		expect(() => parseAttachmentArchiveContract(JSON.stringify(value))).toThrow(
			"byte-limit",
		);
	});
	it.each([
		0,
		-1,
		1.5,
		Number.MAX_SAFE_INTEGER + 1,
	])("rejects invalid byte count %s", (bytes) => {
		const value = manifestValue();
		value.entries[0].content.bytes = bytes;
		expect(() =>
			parseAttachmentArchiveManifestContract(JSON.stringify(value)),
		).toThrow();
	});
	it("rejects unsafe ids, invalid timestamp/hash and wrong DEK length", () => {
		for (const id of ["", "a|b", "../file", "x".repeat(129)]) {
			const value = manifestValue();
			value.entries[0].source.id = id;
			expect(() =>
				parseAttachmentArchiveManifestContract(JSON.stringify(value)),
			).toThrow();
		}
		const value = manifestValue();
		value.entries[0].source.dekWrapped = wire(31);
		expect(() =>
			parseAttachmentArchiveManifestContract(JSON.stringify(value)),
		).toThrow();
		value.entries[0].source.dekWrapped = wire(32);
		value.exportedAt = "2026-10-05";
		expect(() =>
			parseAttachmentArchiveManifestContract(JSON.stringify(value)),
		).toThrow();
		value.exportedAt = "2026-10-05T00:00:00.000Z";
		value.entries[0].content.sha256 = "A".repeat(64);
		expect(() =>
			parseAttachmentArchiveManifestContract(JSON.stringify(value)),
		).toThrow();
	});
	it("binds object membership, observed lengths and null thumbnail parity", () => {
		const value = archiveValue();
		value.objects[0].thumbnail = encodeBytes(new Uint8Array(50));
		expect(() =>
			assertAttachmentArchiveObjectBinding(
				parseAttachmentArchiveContract(JSON.stringify(value)),
				manifest(),
			),
		).toThrow("binding-mismatch");
		value.objects[0].thumbnail = null;
		value.objects[0].content = encodeBytes(new Uint8Array(49));
		expect(() =>
			assertAttachmentArchiveObjectBinding(
				parseAttachmentArchiveContract(JSON.stringify(value)),
				manifest(),
			),
		).toThrow();
		value.objects[0].content = encodeBytes(new Uint8Array(50));
		value.archiveId = "d7c195de-fd79-4598-bf09-1d542378ee54";
		expect(() =>
			assertAttachmentArchiveObjectBinding(
				parseAttachmentArchiveContract(JSON.stringify(value)),
				manifest(),
			),
		).toThrow();
	});
	it.each([
		"id",
		"workspaceId",
		"parentKind",
		"parentId",
		"keyVersion",
		"declaredBytes",
		"observedBytes",
		"ciphertextSha256",
		"thumbnailDeclaredBytes",
		"thumbnailObservedBytes",
		"thumbnailCiphertextSha256",
		"committedAt",
	] as const)("refuses source-row mismatch %s", (field) => {
		const document = documentValue();
		Object.assign(document.data.attachments[0], {
			[field]: field === "committedAt" ? null : "different",
		});
		expect(() =>
			assertAttachmentArchivePortableRowBinding(manifest(), document),
		).toThrow("binding-mismatch");
	});
	it("requires matching source content identity and keeps file digest caller-owned", () => {
		const document = documentValue();
		document.sourceUserId = "different";
		expect(() =>
			assertAttachmentArchivePortableRowBinding(manifest(), document),
		).toThrow();
		const value = manifestValue();
		expect(() =>
			parseAttachmentArchiveManifestContract(
				JSON.stringify({
					...value,
					contentDocument: { ...value.contentDocument, schemaVersion: 2 },
				}),
			),
		).toThrow();
		const opened = parseAttachmentArchiveManifestContract(
			JSON.stringify({
				...value,
				contentDocument: {
					...value.contentDocument,
					schemaVersion: 2,
					sourceNamespace: archiveId,
				},
			}),
		);
		expect(() =>
			assertAttachmentArchivePortableRowBinding(opened, documentValue()),
		).toThrow();
	});
	it("admits thumbnail parity and existing v2 identity without enabling history apply", () => {
		const value = manifestValue();
		value.entries[0].thumbnail = { bytes: 50, sha256: hash };
		value.contentDocument.schemaVersion = 2;
		value.contentDocument.sourceNamespace = archiveId;
		const opened = parseAttachmentArchiveManifestContract(
			JSON.stringify(value),
		);
		const payload = archiveValue();
		payload.objects[0].thumbnail = encodeBytes(new Uint8Array(50));
		assertAttachmentArchiveObjectBinding(
			parseAttachmentArchiveContract(JSON.stringify(payload)),
			opened,
		);
		const original = documentValue();
		Object.assign(original.data.attachments[0], {
			thumbnailDeclaredBytes: 50,
			thumbnailObservedBytes: 50,
			thumbnailCiphertextSha256: hash,
		});
		const {
			comments: _comments,
			templates: _templates,
			...rows
		} = original.data;
		const document = {
			...original,
			schemaVersion: 2 as const,
			sourceNamespace: archiveId,
			boundaries: {
				...original.boundaries,
				taskHistory: "recorded-events-only" as const,
			},
			data: { ...rows, comments: [], templates: [], completionEvents: [] },
		};
		assertAttachmentArchivePortableRowBinding(opened, document);
		expect(() =>
			assertAttachmentArchivePortableRowBinding(opened, {
				...document,
				sourceNamespace: entryId,
			}),
		).toThrow("binding-mismatch");
	});
	it("rejects duplicate source id even across workspaces and noncanonical object/wrap tails", () => {
		const value = manifestValue();
		value.entries.push({
			...value.entries[0],
			entryId: "437ba766-b159-46c8-b6f1-ab0d02eb75ba",
			source: { ...value.entries[0].source, workspaceId: "other-workspace" },
		});
		expect(() =>
			parseAttachmentArchiveManifestContract(JSON.stringify(value)),
		).toThrow();
		const payload = archiveValue();
		payload.objects[0].content = `${"A".repeat(66)}B`;
		expect(() =>
			parseAttachmentArchiveContract(JSON.stringify(payload)),
		).toThrow();
		const original = manifestValue();
		original.entries[0].source.dekWrapped = `${wire(32).slice(0, -1)}B`;
		expect(() =>
			parseAttachmentArchiveManifestContract(JSON.stringify(original)),
		).toThrow();
	});
	it("constructs deterministic domain-separated AAD with all unlock context", () => {
		const value = archive();
		expect(new TextDecoder().decode(attachmentArchiveAad(value))).toBe(
			`ditero:attachment-archive:v1|${archiveId}|1|AAAAAAAAAAAAAAAAAAAAAA`,
		);
		expect(
			attachmentArchiveAad({
				...value,
				archiveId: "d7c195de-fd79-4598-bf09-1d542378ee54",
			}),
		).not.toEqual(attachmentArchiveAad(value));
		expect(() =>
			attachmentArchiveAad({ ...value, archiveId: "a|b" }),
		).toThrow();
	});
});
