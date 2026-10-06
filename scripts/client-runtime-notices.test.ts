import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
	CLIENT_RUNTIME_IDENTITY,
	type RuntimeNoticeFile,
	validateClientRuntimeNotices,
} from "./client-runtime-notices.ts";

const bytes = new Uint8Array(
	readFileSync(new URL("../LICENSE", import.meta.url)),
);
function fixture() {
	const path = "notices/runtime/fixture/LICENSE.txt";
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const origin = {
		url: "https://example.com/source/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/LICENSE",
		revision: "a".repeat(40),
	};
	return {
		manifest: {
			schema: 1,
			identity: { ...CLIENT_RUNTIME_IDENTITY },
			incomplete: true,
			texts: [
				{
					path,
					sha256,
					origin,
					license: "MIT",
					selection: "conservative-extra",
				},
			],
			unresolved: [
				{
					component: "runtime",
					reason: "Artifact linkage remains unqualified",
				},
			],
			sourceRelink: { source: null, relink: null },
		},
		files: [{ path, kind: "file", bytes }] as RuntimeNoticeFile[],
	};
}
describe("client runtime notice integrity", () => {
	test("accepts exact candidate bytes without promoting completeness", () => {
		const { manifest, files } = fixture();
		const result = validateClientRuntimeNotices(manifest, files);
		expect(result.incomplete).toBe(true);
		expect(result.unresolved).toEqual(manifest.unresolved);
	});
	test.each([
		"bunVersion",
		"bunRevision",
		"target",
		"runtimeArchiveSha256",
		"webkitCommit",
	])("rejects changed %s identity", (key) => {
		const { manifest, files } = fixture();
		expect(() =>
			validateClientRuntimeNotices(
				{ ...manifest, identity: { ...manifest.identity, [key]: "wrong" } },
				files,
			),
		).toThrow();
	});
	test.each([
		"../LICENSE",
		"/LICENSE",
		"notices/runtime/../LICENSE",
		"notices/runtime/.hidden/LICENSE",
		"notices/runtime/a\\b",
	])("rejects unsafe path %s", (path) => {
		const { manifest, files } = fixture();
		manifest.texts[0].path = path;
		expect(() => validateClientRuntimeNotices(manifest, files)).toThrow();
	});
	test("rejects mismatched bytes, missing/extra/duplicate and nonregular files", () => {
		const { manifest, files } = fixture();
		for (const entries of [
			[],
			[...files, { ...files[0], path: "notices/runtime/extra" }],
			[...files, ...files],
			[{ ...files[0], kind: "symlink" as const }],
			[{ ...files[0], bytes: new TextEncoder().encode("changed") }],
		])
			expect(() => validateClientRuntimeNotices(manifest, entries)).toThrow();
	});
	test("rejects duplicate records and malformed hashes", () => {
		const { manifest, files } = fixture();
		expect(() =>
			validateClientRuntimeNotices(
				{ ...manifest, texts: [...manifest.texts, ...manifest.texts] },
				files,
			),
		).toThrow();
		manifest.texts[0].sha256 = "ABC";
		expect(() => validateClientRuntimeNotices(manifest, files)).toThrow();
	});
	test.each([
		"main",
		"master",
		"HEAD",
		"latest",
		"nightly",
	])("rejects moving origin %s", (ref) => {
		const { manifest, files } = fixture();
		manifest.texts[0].origin.url = `https://example.com/${ref}/${"a".repeat(40)}/LICENSE`;
		expect(() => validateClientRuntimeNotices(manifest, files)).toThrow();
	});
	test("rejects unbound origin, unknown fields and completeness promotion", () => {
		const { manifest, files } = fixture();
		expect(() =>
			validateClientRuntimeNotices({ ...manifest, incomplete: false }, files),
		).toThrow();
		expect(() =>
			validateClientRuntimeNotices({ ...manifest, approved: true }, files),
		).toThrow();
		manifest.texts[0].origin.url = "https://example.com/LICENSE";
		expect(() => validateClientRuntimeNotices(manifest, files)).toThrow();
	});
	test.each([
		"Copyright [year] [copyright holder]\nPermission granted",
		"Bun is MIT-licensed.",
		"Copyright Someone\nTODO",
		"Copyright Someone\nLicense\0",
		"Permission granted without attribution",
	])("rejects incomplete or placeholder text %s", (content) => {
		const { manifest, files } = fixture();
		files[0].bytes = new TextEncoder().encode(content);
		manifest.texts[0].sha256 = createHash("sha256")
			.update(files[0].bytes)
			.digest("hex");
		expect(() => validateClientRuntimeNotices(manifest, files)).toThrow();
	});
	test("binds source/relink receipts to exact supplied bytes", () => {
		const { manifest, files } = fixture();
		const receipt = {
			...manifest.texts[0],
			path: "notices/runtime/source/receipt.json",
		};
		const { license: _license, selection: _selection, ...record } = receipt;
		const input = {
			...manifest,
			sourceRelink: { source: record, relink: null },
		};
		expect(() => validateClientRuntimeNotices(input, files)).toThrow("Missing");
		expect(
			validateClientRuntimeNotices(input, [
				...files,
				{ ...files[0], path: record.path },
			]).incomplete,
		).toBe(true);
	});
	test("rejects malformed UTF-8, empty/oversized texts and file-count overflow", () => {
		const { manifest, files } = fixture();
		for (const value of [
			new Uint8Array(),
			new Uint8Array([0xff]),
			new Uint8Array(8 * 1024 * 1024 + 1),
		]) {
			const changed = { ...files[0], bytes: value };
			const record = {
				...manifest.texts[0],
				sha256: createHash("sha256").update(value).digest("hex"),
			};
			expect(() =>
				validateClientRuntimeNotices({ ...manifest, texts: [record] }, [
					changed,
				]),
			).toThrow();
		}
		expect(() =>
			validateClientRuntimeNotices(
				manifest,
				Array.from({ length: 513 }, () => files[0]),
			),
		).toThrow();
	});
	test("rejects encoded moving refs, unpinned versions and selection classes", () => {
		const { manifest, files } = fixture();
		expect(() =>
			validateClientRuntimeNotices(
				{
					...manifest,
					texts: [
						{
							...manifest.texts[0],
							origin: {
								...manifest.texts[0].origin,
								url: `https://example.com/%6dain/${"a".repeat(40)}/LICENSE`,
							},
						},
					],
				},
				files,
			),
		).toThrow();
		expect(() =>
			validateClientRuntimeNotices(
				{ ...manifest, texts: [{ ...manifest.texts[0], selection: "linked" }] },
				files,
			),
		).toThrow();
		expect(() =>
			validateClientRuntimeNotices(
				{
					...manifest,
					texts: [
						{
							...manifest.texts[0],
							origin: { ...manifest.texts[0].origin, revision: "1.4" },
						},
					],
				},
				files,
			),
		).toThrow();
	});
});
