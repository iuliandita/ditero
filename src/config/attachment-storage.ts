import type { BlobStore } from "../server/storage/blob-store.ts";
import { FsBlobStore } from "../server/storage/fs-store.ts";
import { positiveInt } from "./env.ts";

export const DEFAULT_ATTACHMENT_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;
export const DEFAULT_ATTACHMENT_PATH = "data/attachments";

type S3Options = {
	bucket: string;
	region: string;
	endpoint?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
};

export type AttachmentStorageConfig =
	| {
			driver: "filesystem";
			path: string;
			quotaBytes: number;
	  }
	| {
			driver: "s3";
			options: S3Options;
			quotaBytes: number;
	  };

const S3_KEYS = [
	"DITERO_ATTACHMENT_S3_BUCKET",
	"DITERO_ATTACHMENT_S3_REGION",
	"DITERO_ATTACHMENT_S3_ENDPOINT",
	"DITERO_ATTACHMENT_S3_ACCESS_KEY_ID",
	"DITERO_ATTACHMENT_S3_SECRET_ACCESS_KEY",
] as const;

function present(value: string | undefined): boolean {
	return value !== undefined && value !== "";
}

function requiredTrimmed(
	env: Record<string, string | undefined>,
	name: string,
): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`${name} is required for S3 attachment storage`);
	return value;
}

function endpoint(raw: string | undefined): string | undefined {
	const value = raw?.trim();
	if (!value) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(
			"DITERO_ATTACHMENT_S3_ENDPOINT must be an absolute HTTP or HTTPS URL",
		);
	}
	if (
		!(["http:", "https:"] as const).includes(
			parsed.protocol as "http:" | "https:",
		) ||
		parsed.username !== "" ||
		parsed.password !== ""
	) {
		throw new Error(
			"DITERO_ATTACHMENT_S3_ENDPOINT must be an absolute HTTP or HTTPS URL without credentials",
		);
	}
	return value;
}

function quotaBytes(env: Record<string, string | undefined>): number {
	const value = positiveInt(
		"DITERO_ATTACHMENT_QUOTA_BYTES",
		env.DITERO_ATTACHMENT_QUOTA_BYTES,
		DEFAULT_ATTACHMENT_QUOTA_BYTES,
	);
	if (!Number.isSafeInteger(value)) {
		throw new Error(
			`DITERO_ATTACHMENT_QUOTA_BYTES: expected a positive safe integer, got "${env.DITERO_ATTACHMENT_QUOTA_BYTES}"`,
		);
	}
	return value;
}

export function attachmentStorageConfig(
	env: Record<string, string | undefined>,
): AttachmentStorageConfig {
	const driver = env.DITERO_ATTACHMENT_STORAGE_DRIVER?.trim() || "filesystem";
	if (driver !== "filesystem" && driver !== "s3") {
		throw new Error(
			`DITERO_ATTACHMENT_STORAGE_DRIVER: expected "filesystem" or "s3", got "${driver}"`,
		);
	}
	const quota = quotaBytes(env);

	if (driver === "filesystem") {
		const stray = S3_KEYS.filter((name) => present(env[name]));
		if (stray.length > 0) {
			throw new Error(
				`${stray.join(", ")} set while attachment storage uses filesystem`,
			);
		}
		const path =
			env.DITERO_ATTACHMENT_FS_PATH?.trim() || DEFAULT_ATTACHMENT_PATH;
		if (/\0/.test(path)) {
			throw new Error("DITERO_ATTACHMENT_FS_PATH must not contain NUL bytes");
		}
		return { driver, path, quotaBytes: quota };
	}

	if (present(env.DITERO_ATTACHMENT_FS_PATH)) {
		throw new Error(
			"DITERO_ATTACHMENT_FS_PATH is set while attachment storage uses s3",
		);
	}
	const accessKeyId = env.DITERO_ATTACHMENT_S3_ACCESS_KEY_ID?.trim();
	const secretAccessKey = env.DITERO_ATTACHMENT_S3_SECRET_ACCESS_KEY;
	if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
		throw new Error(
			"DITERO_ATTACHMENT_S3_ACCESS_KEY_ID and DITERO_ATTACHMENT_S3_SECRET_ACCESS_KEY must be set together",
		);
	}
	const options: S3Options = {
		bucket: requiredTrimmed(env, "DITERO_ATTACHMENT_S3_BUCKET"),
		region: requiredTrimmed(env, "DITERO_ATTACHMENT_S3_REGION"),
	};
	const configuredEndpoint = endpoint(env.DITERO_ATTACHMENT_S3_ENDPOINT);
	if (configuredEndpoint) options.endpoint = configuredEndpoint;
	if (accessKeyId && secretAccessKey) {
		options.accessKeyId = accessKeyId;
		options.secretAccessKey = secretAccessKey;
	}
	return { driver, options, quotaBytes: quota };
}

export async function createAttachmentBlobStore(
	config: AttachmentStorageConfig,
): Promise<BlobStore> {
	if (config.driver === "filesystem") return new FsBlobStore(config.path);
	const { S3BlobStore } = await import("../server/storage/s3-store.ts");
	return new S3BlobStore(config.options);
}
