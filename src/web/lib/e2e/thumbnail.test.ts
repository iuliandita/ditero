import { describe, expect, test, vi } from "vitest";
import {
	createAttachmentThumbnail,
	THUMBNAIL_MAX_EDGE,
	type ThumbnailPlatform,
} from "./thumbnail.ts";

function platform(width = 1200, height = 600) {
	const close = vi.fn();
	const drawImage = vi.fn();
	const encodePng = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
	const value: ThumbnailPlatform = {
		decode: vi.fn(async () => ({ width, height, close, source: {} })),
		encodePng,
		drawImage,
	};
	return { value, close, drawImage, encodePng };
}

describe("createAttachmentThumbnail", () => {
	test("decodes, bounds, and re-encodes a previewable image as PNG", async () => {
		const mock = platform();

		const thumbnail = await createAttachmentThumbnail(
			new Blob(["hostile-container"], { type: "image/jpeg" }),
			mock.value,
		);

		expect(thumbnail?.type).toBe("image/png");
		expect(mock.drawImage).toHaveBeenCalledWith(
			expect.anything(),
			THUMBNAIL_MAX_EDGE,
			THUMBNAIL_MAX_EDGE / 2,
		);
		expect(mock.encodePng).toHaveBeenCalledWith(
			THUMBNAIL_MAX_EDGE,
			THUMBNAIL_MAX_EDGE / 2,
		);
		expect(mock.close).toHaveBeenCalledOnce();
	});

	test("never decodes a type outside the passive allowlist", async () => {
		const mock = platform();

		expect(
			await createAttachmentThumbnail(
				new Blob(["<svg/>"], { type: "image/svg+xml" }),
				mock.value,
			),
		).toBeNull();
		expect(mock.value.decode).not.toHaveBeenCalled();
	});

	test("closes decoded resources when PNG encoding fails", async () => {
		const mock = platform(100, 50);
		mock.encodePng.mockRejectedValueOnce(new Error("canvas refused"));

		await expect(
			createAttachmentThumbnail(
				new Blob(["image"], { type: "image/webp" }),
				mock.value,
			),
		).rejects.toThrow("canvas refused");
		expect(mock.close).toHaveBeenCalledOnce();
	});

	test("refuses invalid decoded dimensions before allocating a canvas", async () => {
		const mock = platform(Number.MAX_VALUE, Number.NaN);

		await expect(
			createAttachmentThumbnail(
				new Blob(["image"], { type: "image/png" }),
				mock.value,
			),
		).rejects.toThrow(/dimensions/);
		expect(mock.encodePng).not.toHaveBeenCalled();
		expect(mock.close).toHaveBeenCalledOnce();
	});
});
