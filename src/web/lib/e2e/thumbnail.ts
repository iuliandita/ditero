import { isPreviewable } from "../../../domain/attachment.ts";

export const THUMBNAIL_MAX_EDGE = 320;

export type DecodedThumbnailSource = {
	width: number;
	height: number;
	source: unknown;
	close: () => void;
};

export type ThumbnailPlatform = {
	decode: (source: Blob) => Promise<DecodedThumbnailSource>;
	drawImage: (
		source: DecodedThumbnailSource,
		width: number,
		height: number,
	) => void;
	encodePng: (width: number, height: number) => Promise<Blob>;
};

function browserPlatform(): ThumbnailPlatform {
	let canvas: HTMLCanvasElement | null = null;
	return {
		async decode(source) {
			if (typeof createImageBitmap !== "function") {
				throw new Error("thumbnail: image decoding is unavailable");
			}
			const bitmap = await createImageBitmap(source);
			return {
				width: bitmap.width,
				height: bitmap.height,
				source: bitmap,
				close: () => bitmap.close(),
			};
		},
		drawImage(source, width, height) {
			if (typeof document === "undefined") {
				throw new Error("thumbnail: canvas is unavailable");
			}
			canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d");
			if (!context) throw new Error("thumbnail: 2D canvas is unavailable");
			context.drawImage(
				source.source as CanvasImageSource,
				0,
				0,
				width,
				height,
			);
		},
		async encodePng(width, height) {
			if (!canvas || canvas.width !== width || canvas.height !== height) {
				throw new Error("thumbnail: canvas was not prepared");
			}
			return await new Promise<Blob>((resolve, reject) => {
				canvas?.toBlob((blob) => {
					if (blob) resolve(blob);
					else reject(new Error("thumbnail: PNG encoding failed"));
				}, "image/png");
			});
		},
	};
}

export async function createAttachmentThumbnail(
	source: Blob,
	platform: ThumbnailPlatform = browserPlatform(),
): Promise<Blob | null> {
	if (!isPreviewable(source.type)) return null;
	const decoded = await platform.decode(source);
	try {
		if (
			!Number.isFinite(decoded.width) ||
			!Number.isFinite(decoded.height) ||
			decoded.width <= 0 ||
			decoded.height <= 0
		) {
			throw new Error("thumbnail: decoded image has invalid dimensions");
		}
		const scale = Math.min(
			1,
			THUMBNAIL_MAX_EDGE / Math.max(decoded.width, decoded.height),
		);
		const width = Math.max(1, Math.round(decoded.width * scale));
		const height = Math.max(1, Math.round(decoded.height * scale));
		platform.drawImage(decoded, width, height);
		const thumbnail = await platform.encodePng(width, height);
		if (thumbnail.type !== "image/png") {
			throw new Error("thumbnail: encoder did not produce PNG");
		}
		return thumbnail;
	} finally {
		decoded.close();
	}
}
