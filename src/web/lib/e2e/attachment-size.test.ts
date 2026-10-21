import { expect, it } from "vitest";
import { attachmentSizeLabel } from "./attachment-size.ts";

it.each([
	[49, "0 byte"],
	[265, "216 byte"],
	[1072, "1,023 byte"],
	[1073, "1 kB"],
	[1088, "1 kB"],
	[1089, "Stored size: 1.1 kB"],
])("labels %i stored bytes without assuming a segment size", (stored, label) => {
	expect(attachmentSizeLabel(stored)).toBe(label);
});
