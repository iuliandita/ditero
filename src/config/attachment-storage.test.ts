import { describe, expect, it } from "vitest";
import { FsBlobStore } from "../server/storage/fs-store.ts";
import {
	attachmentStorageConfig,
	createAttachmentBlobStore,
} from "./attachment-storage.ts";

describe("attachmentStorageConfig", () => {
	it("defaults to a local filesystem store with a 10 GiB workspace quota", () => {
		expect(attachmentStorageConfig({})).toEqual({
			driver: "filesystem",
			path: "data/attachments",
			quotaBytes: 10 * 1024 * 1024 * 1024,
		});
	});

	it("accepts an explicit filesystem path and safe-integer quota", () => {
		expect(
			attachmentStorageConfig({
				DITERO_ATTACHMENT_STORAGE_DRIVER: "filesystem",
				DITERO_ATTACHMENT_FS_PATH: "/srv/ditero/blobs",
				DITERO_ATTACHMENT_QUOTA_BYTES: "123456",
			}),
		).toEqual({
			driver: "filesystem",
			path: "/srv/ditero/blobs",
			quotaBytes: 123456,
		});
	});

	it("constructs the filesystem driver without loading the Bun-only S3 module", async () => {
		const store = await createAttachmentBlobStore(
			attachmentStorageConfig({ DITERO_ATTACHMENT_FS_PATH: "/tmp/blobs" }),
		);

		expect(store).toBeInstanceOf(FsBlobStore);
	});

	it("parses an S3-compatible store without requiring a custom endpoint", () => {
		expect(
			attachmentStorageConfig({
				DITERO_ATTACHMENT_STORAGE_DRIVER: "s3",
				DITERO_ATTACHMENT_S3_BUCKET: "encrypted-blobs",
				DITERO_ATTACHMENT_S3_REGION: "us-east-1",
				DITERO_ATTACHMENT_S3_ACCESS_KEY_ID: "access",
				DITERO_ATTACHMENT_S3_SECRET_ACCESS_KEY: "secret",
			}),
		).toEqual({
			driver: "s3",
			quotaBytes: 10 * 1024 * 1024 * 1024,
			options: {
				bucket: "encrypted-blobs",
				region: "us-east-1",
				accessKeyId: "access",
				secretAccessKey: "secret",
			},
		});
	});

	it("accepts an HTTP or HTTPS S3 endpoint", () => {
		const config = attachmentStorageConfig({
			DITERO_ATTACHMENT_STORAGE_DRIVER: "s3",
			DITERO_ATTACHMENT_S3_BUCKET: "encrypted-blobs",
			DITERO_ATTACHMENT_S3_REGION: "auto",
			DITERO_ATTACHMENT_S3_ENDPOINT: "https://objects.example.test",
		});

		expect(config).toMatchObject({
			driver: "s3",
			options: { endpoint: "https://objects.example.test" },
		});
	});

	it("rejects unknown drivers and invalid quotas", () => {
		expect(() =>
			attachmentStorageConfig({ DITERO_ATTACHMENT_STORAGE_DRIVER: "memory" }),
		).toThrow(/DITERO_ATTACHMENT_STORAGE_DRIVER/);
		for (const quota of ["0", "1.5", String(Number.MAX_SAFE_INTEGER + 1)]) {
			expect(() =>
				attachmentStorageConfig({ DITERO_ATTACHMENT_QUOTA_BYTES: quota }),
			).toThrow(/DITERO_ATTACHMENT_QUOTA_BYTES/);
		}
	});

	it("rejects missing S3 bucket, region, and half-configured credentials", () => {
		expect(() =>
			attachmentStorageConfig({
				DITERO_ATTACHMENT_STORAGE_DRIVER: "s3",
				DITERO_ATTACHMENT_S3_REGION: "us-east-1",
			}),
		).toThrow(/DITERO_ATTACHMENT_S3_BUCKET/);
		expect(() =>
			attachmentStorageConfig({
				DITERO_ATTACHMENT_STORAGE_DRIVER: "s3",
				DITERO_ATTACHMENT_S3_BUCKET: "encrypted-blobs",
			}),
		).toThrow(/DITERO_ATTACHMENT_S3_REGION/);
		expect(() =>
			attachmentStorageConfig({
				DITERO_ATTACHMENT_STORAGE_DRIVER: "s3",
				DITERO_ATTACHMENT_S3_BUCKET: "encrypted-blobs",
				DITERO_ATTACHMENT_S3_REGION: "us-east-1",
				DITERO_ATTACHMENT_S3_ACCESS_KEY_ID: "access",
			}),
		).toThrow(/must be set together/);
	});

	it("rejects malformed endpoints and driver-specific settings that would be ignored", () => {
		expect(() =>
			attachmentStorageConfig({
				DITERO_ATTACHMENT_STORAGE_DRIVER: "s3",
				DITERO_ATTACHMENT_S3_BUCKET: "encrypted-blobs",
				DITERO_ATTACHMENT_S3_REGION: "us-east-1",
				DITERO_ATTACHMENT_S3_ENDPOINT: "file:///tmp/bucket",
			}),
		).toThrow(/DITERO_ATTACHMENT_S3_ENDPOINT/);
		expect(() =>
			attachmentStorageConfig({ DITERO_ATTACHMENT_S3_BUCKET: "ignored" }),
		).toThrow(/filesystem/);
		expect(() =>
			attachmentStorageConfig({
				DITERO_ATTACHMENT_STORAGE_DRIVER: "s3",
				DITERO_ATTACHMENT_FS_PATH: "/ignored",
				DITERO_ATTACHMENT_S3_BUCKET: "encrypted-blobs",
				DITERO_ATTACHMENT_S3_REGION: "us-east-1",
			}),
		).toThrow(/s3/);
	});
});
