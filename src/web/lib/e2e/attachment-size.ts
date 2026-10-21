import {
	HEADER_BYTES,
	MIN_SEGMENT_BYTES,
	TAG_BYTES,
} from "../../../domain/e2e/stream.ts";
import { m } from "../../../paraglide/messages.js";
import { formatBytes } from "../intl-format.ts";

export function attachmentSizeLabel(storedBytes: number): string {
	// Rows have no segment size. A second tag requires a full minimum-sized
	// segment plus the final tag; longer streams cannot be inverted uniquely.
	const plaintext = storedBytes - HEADER_BYTES - TAG_BYTES;
	if (
		Number.isSafeInteger(plaintext) &&
		plaintext >= 0 &&
		plaintext < MIN_SEGMENT_BYTES + TAG_BYTES
	) {
		return formatBytes(plaintext);
	}
	return m.attachment_stored_size({ size: formatBytes(storedBytes) });
}
