// Header-value hygiene shared by every channel that puts a user-supplied task
// title into a header: ntfy's X-Title (HTTP) and the email transport's Subject
// (SMTP). One implementation, because the two failure modes are the same one --
// a CR/LF in a task title is header injection, and a non-ASCII title is mojibake
// unless it is encoded.

// A header value is single-line by definition. In HTTP a CR/LF makes undici
// reject the request outright, turning a badly-named task into a permanent
// delivery failure; in SMTP it splices an attacker-chosen header (or a body)
// into the message. The other C0 controls go too -- invisible in a
// notification, useful only for smuggling.
export function headerSafe(value: string, max: number): string {
	let out = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		out += code < 0x20 || code === 0x7f ? " " : character;
	}
	return out.replace(/\s+/g, " ").trim().slice(0, max);
}

// Header values serialize as latin1 (HTTP) or are restricted to ASCII (RFC 5322),
// so an Arabic, Hebrew or Chinese title arrives as mojibake. RFC 2047
// encoded-words are the documented escape hatch for both -- ntfy names it
// explicitly ("you may also encode any header (including the title) as RFC 2047,
// e.g. =?UTF-8?B?8J+HqfCfh6o=?="), and it is how Subject has carried non-ASCII
// since 1996. Applied only when needed: an ASCII value stays human-readable on
// the wire, and the encoded form costs ~33% more length.
export function encodeHeaderValue(value: string): string {
	if (/^[\x20-\x7e]*$/.test(value)) return value;
	return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
