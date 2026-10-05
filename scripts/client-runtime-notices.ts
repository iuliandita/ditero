import { createHash } from "node:crypto";
import { z } from "zod";

export const CLIENT_RUNTIME_IDENTITY = Object.freeze({
	bunVersion: "1.4.2",
	bunRevision: "744846f844374847c902b5e7fd59b4342a51ef99",
	target: "bun-linux-x64",
	runtimeArchiveSha256:
		"36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913",
	webkitCommit: "2e2aa2290fac856d6f451ceacb58f7f5b44dd057",
});
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z
	.string()
	.max(240)
	.regex(
		/^notices\/runtime\/(?:[A-Za-z0-9_+-][A-Za-z0-9_.+-]*\/)*[A-Za-z0-9_+-][A-Za-z0-9_.+-]*$/,
	)
	.refine(
		(value) => !value.split("/").some((part) => part === "." || part === ".."),
	);
const origin = z
	.object({
		url: z.string().max(2048),
		revision: z
			.string()
			.regex(
				/^(?:[a-f0-9]{40}|[a-f0-9]{64}|[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)$/,
			),
	})
	.strict()
	.superRefine((value, ctx) => {
		let url: URL;
		try {
			url = new URL(value.url);
		} catch {
			ctx.addIssue({ code: "custom", message: "Invalid notice origin" });
			return;
		}
		if (
			value.url !== url.href ||
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			/(?:^|\/)(?:main|master|HEAD|latest|nightly)(?:\/|$)/i.test(
				decodeURIComponent(url.pathname),
			) ||
			!url.pathname
				.split("/")
				.some(
					(part) => part === value.revision || part === `v${value.revision}`,
				)
		)
			ctx.addIssue({
				code: "custom",
				message: "Notice origin must contain its immutable revision",
			});
	});
const receipt = z.object({ path, sha256: hash, origin }).strict();
const text = receipt
	.extend({
		license: z
			.string()
			.min(1)
			.max(120)
			.regex(/^[A-Za-z0-9().+ -]+$/),
		selection: z.enum(["target", "build-host", "conservative-extra"]),
	})
	.strict();
const manifestSchema = z
	.object({
		schema: z.literal(1),
		identity: z
			.object({
				bunVersion: z.literal(CLIENT_RUNTIME_IDENTITY.bunVersion),
				bunRevision: z.literal(CLIENT_RUNTIME_IDENTITY.bunRevision),
				target: z.literal(CLIENT_RUNTIME_IDENTITY.target),
				runtimeArchiveSha256: z.literal(
					CLIENT_RUNTIME_IDENTITY.runtimeArchiveSha256,
				),
				webkitCommit: z.literal(CLIENT_RUNTIME_IDENTITY.webkitCommit),
			})
			.strict(),
		// Integrity validation never qualifies a binary for distribution.
		incomplete: z.literal(true),
		texts: z.array(text).min(1).max(512),
		unresolved: z
			.array(
				z
					.object({
						component: z.string().min(1).max(200),
						reason: z.string().min(1).max(2048),
					})
					.strict(),
			)
			.max(128),
		sourceRelink: z
			.object({ source: receipt.nullable(), relink: receipt.nullable() })
			.strict(),
	})
	.strict();
export type ClientRuntimeNoticeManifest = z.infer<typeof manifestSchema>;
export type RuntimeNoticeFile = {
	path: string;
	kind: "file" | "symlink" | "directory";
	bytes: Uint8Array;
};

/** Checks package integrity, not linkage coverage, license interpretation, or relinking. */
export function validateClientRuntimeNotices(
	input: unknown,
	files: readonly RuntimeNoticeFile[],
): ClientRuntimeNoticeManifest {
	const manifest = manifestSchema.parse(input);
	const records = [
		...manifest.texts,
		...Object.values(manifest.sourceRelink).filter((item) => item !== null),
	];
	if (records.length > 512 || files.length > 512)
		throw new Error("Runtime notice file limit");
	const expected = new Map(records.map((record) => [record.path, record]));
	if (expected.size !== records.length)
		throw new Error("Duplicate runtime notice path");
	const seen = new Set<string>();
	let total = 0;
	for (const file of files) {
		const record = expected.get(file.path);
		if (
			!record ||
			seen.has(file.path) ||
			file.kind !== "file" ||
			!(file.bytes instanceof Uint8Array)
		)
			throw new Error("Unexpected runtime notice file");
		seen.add(file.path);
		total += file.bytes.byteLength;
		if (
			!file.bytes.byteLength ||
			file.bytes.byteLength > 8 * 1024 * 1024 ||
			total > 512 * 1024 * 1024
		)
			throw new Error("Runtime notice size limit");
		if (createHash("sha256").update(file.bytes).digest("hex") !== record.sha256)
			throw new Error("Runtime notice hash mismatch");
		const content = new TextDecoder("utf-8", { fatal: true }).decode(
			file.bytes,
		);
		if (content.includes("\0")) throw new Error("Invalid runtime notice text");
		if (manifest.texts.some((item) => item.path === file.path)) {
			if (
				/(?:\[(?:year|copyright holder|name of author|insert[^\]]*)\]|<copyright[^>]*>|^\s*(?:TODO|TBD|PLACEHOLDER)\s*$)/im.test(
					content,
				)
			)
				throw new Error("Placeholder runtime notice");
			if (
				!/(?:^\s*(?:\*\s*)?copyright\s*(?:\(c\)|©)?\s*(?:[0-9]{4}|[A-Z])|public domain)/im.test(
					content,
				) ||
				!/(?:permission|redistribution|license|licence|SPDX)/i.test(content)
			)
				throw new Error("Missing runtime notice header or grant");
		}
	}
	if (seen.size !== expected.size)
		throw new Error("Missing runtime notice file");
	return manifest;
}
