import { describe, expect, it } from "vitest";
import { encodeHeaderValue, headerSafe } from "./mime-header.ts";

describe("headerSafe", () => {
	// The whole reason the module exists: a CR/LF in a task title splices a
	// header in SMTP and makes undici reject the request outright in HTTP.
	it("cannot leave a header break in the value", () => {
		expect(headerSafe("Buy milk\r\nBcc: victim@example.test", 200)).toBe(
			"Buy milk Bcc: victim@example.test",
		);
		expect(headerSafe("a\rb\nc", 200)).toBe("a b c");
	});

	it("strips the other C0 controls and DEL", () => {
		expect(headerSafe("a\x00b\x1fc\x7fd", 200)).toBe("a b c d");
		expect(headerSafe("tab\there", 200)).toBe("tab here");
	});

	it("collapses the whitespace a stripped control leaves behind", () => {
		expect(headerSafe("a\r\n\r\n\r\nb", 200)).toBe("a b");
		expect(headerSafe("  padded   out  ", 200)).toBe("padded out");
	});

	// Truncation is last, after collapsing: slicing first would let a run of
	// controls eat the budget.
	it("truncates to max", () => {
		expect(headerSafe("abcdef", 3)).toBe("abc");
		expect(headerSafe("a\r\n\r\nbcdef", 3)).toBe("a b");
		expect(headerSafe("abc", 10)).toBe("abc");
	});

	// The boundary the character loop turns on: 0x20 and 0x7e are printable and
	// must survive, 0x1f and 0x7f must not.
	it("passes 0x20 through 0x7e untouched", () => {
		// No leading or trailing space: those are trimmed, which the collapse
		// case above already covers. 0x20 passthrough is the interior one.
		const printable = "!\"#$%& '()*+,-./09:;<=>?@AZ[\\]^_`az{|}~";
		expect(headerSafe(printable, 200)).toBe(printable);
		expect(headerSafe("\x1f\x20\x7e\x7f", 200)).toBe("~");
	});

	it("keeps non-ASCII, which is encodeHeaderValue's problem", () => {
		expect(headerSafe("Sortir le chien 🐕", 200)).toBe("Sortir le chien 🐕");
	});
});

describe("encodeHeaderValue", () => {
	it("leaves an ASCII value readable on the wire", () => {
		expect(encodeHeaderValue("Walk the dog")).toBe("Walk the dog");
		expect(encodeHeaderValue("")).toBe("");
		// Same 0x20/0x7e boundary, from the other side.
		expect(encodeHeaderValue(" ~")).toBe(" ~");
	});

	it("encodes anything outside it as an RFC 2047 encoded-word", () => {
		const encoded = encodeHeaderValue("Sortir le chien 🐕");
		expect(encoded).toBe(
			`=?UTF-8?B?${Buffer.from("Sortir le chien 🐕", "utf8").toString("base64")}?=`,
		);
		expect(Buffer.from(encoded.slice(10, -2), "base64").toString("utf8")).toBe(
			"Sortir le chien 🐕",
		);
	});

	it("encodes a value that is ASCII but not printable", () => {
		expect(encodeHeaderValue("a\x7fb")).toMatch(/^=\?UTF-8\?B\?/);
		expect(encodeHeaderValue("a\x1fb")).toMatch(/^=\?UTF-8\?B\?/);
	});
});
