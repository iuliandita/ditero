import { describe, expect, it } from "vitest";
import {
	isPreviewable,
	PREVIEWABLE_TYPES,
	quotaWouldExceed,
	sanitiseFilename,
	storageKeyFor,
} from "./attachment.ts";

describe("sanitiseFilename", () => {
	it("strips path separators", () => {
		expect(sanitiseFilename("../../etc/passwd")).toBe("passwd");
		expect(sanitiseFilename("a\\b\\c.txt")).toBe("c.txt");
	});

	it("strips control characters", () => {
		expect(sanitiseFilename("re\u0007port.pdf")).toBe("report.pdf");
		expect(sanitiseFilename("line\nbreak.txt")).toBe("linebreak.txt");
	});

	it("caps the length while keeping the extension", () => {
		const out = sanitiseFilename(`${"a".repeat(400)}.pdf`);
		expect(out.length).toBeLessThanOrEqual(255);
		expect(out.endsWith(".pdf")).toBe(true);
	});

	it("falls back for a name that sanitises to nothing", () => {
		expect(sanitiseFilename("///")).toBe("file");
		expect(sanitiseFilename("..\u0000")).toBe("file");
	});
});

describe("isPreviewable", () => {
	it("refuses svg and html", () => {
		expect(isPreviewable("image/svg+xml")).toBe(false);
		expect(isPreviewable("text/html")).toBe(false);
	});

	it("allows passive raster formats", () => {
		expect(isPreviewable("image/png")).toBe(true);
		expect(isPreviewable("image/jpeg")).toBe(true);
		expect(isPreviewable("image/webp")).toBe(true);
	});

	it("refuses anything outside the allowlist", () => {
		expect(isPreviewable("application/pdf")).toBe(false);
		expect(isPreviewable("")).toBe(false);
	});

	it("is an allowlist, not a denylist", () => {
		expect(PREVIEWABLE_TYPES).toEqual([
			"image/png",
			"image/jpeg",
			"image/webp",
			"image/gif",
		]);
	});
});

describe("quotaWouldExceed", () => {
	it("counts reserved bytes as well as committed", () => {
		expect(
			quotaWouldExceed({ committed: 10, reserved: 5, incoming: 6, limit: 20 }),
		).toBe(true);
		expect(
			quotaWouldExceed({ committed: 10, reserved: 5, incoming: 4, limit: 20 }),
		).toBe(false);
	});

	it("refuses an incoming file larger than the whole quota", () => {
		expect(
			quotaWouldExceed({ committed: 0, reserved: 0, incoming: 21, limit: 20 }),
		).toBe(true);
	});

	it("fails loud on byte counts that could bypass arithmetic", () => {
		for (const incoming of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() =>
				quotaWouldExceed({ committed: 0, reserved: 0, incoming, limit: 20 }),
			).toThrow(/incoming/);
		}
	});
});

describe("storageKeyFor", () => {
	it("derives an opaque key that leaks no metadata", () => {
		expect(storageKeyFor("ws_1", "att_1")).toMatch(
			/^ws_1\/[0-9a-f]{2}\/att_1$/,
		);
	});

	it("gives content and thumbnail distinct keys", () => {
		expect(storageKeyFor("ws_1", "att_1")).not.toBe(
			storageKeyFor("ws_1", "att_1", "thumbnail"),
		);
	});

	it("refuses identifiers that could become path segments", () => {
		expect(() => storageKeyFor("../outside", "att_1")).toThrow(/workspaceId/);
		expect(() => storageKeyFor("ws_1", "a/b")).toThrow(/attachmentId/);
	});
});
