// The one address predicate for everything that hands a value to a mail
// transport: invite mail, Better Auth's verification/reset mail, and anything
// added later. It used to be two hand-rolled parsers of the same grammar with
// different acceptance sets, so an address the invite path would mail was one
// the auth path refused.
//
// Stricter than z.email() on purpose. The failure it closes is severe: the
// value can come off an unauthenticated request body, and nodemailer parses
// `to` as an address LIST, so "a@b.test\r\nBcc: victim@example.test" becomes a
// group and RCPT TO goes to the victim INSTEAD of the intended recipient --
// reporting success. A hijacked password-reset mail is account takeover.
// transport.ts rejects controls in `to` as well; this is the caller-side half.

// RFC 5321 4.5.3.1.3 caps the forward-path at 256 octets INCLUDING the angle
// brackets, so the address itself gets 254.
export const ADDRESS_MAX = 254;

// Control characters, the RFC 5322 address-list separators, and the group
// syntax.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const UNSAFE_ADDRESS = /[\x00-\x1f\x7f<>,;:"\\()[\]\s]/;
const DOMAIN =
	/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

// Null means "do not hand this to a mail transport".
export function mailableAddress(value: string): string | null {
	if (value.length === 0 || value.length > ADDRESS_MAX) return null;
	if (UNSAFE_ADDRESS.test(value)) return null;
	const at = value.indexOf("@");
	if (at <= 0 || at !== value.lastIndexOf("@")) return null;
	if (!DOMAIN.test(value.slice(at + 1))) return null;
	return value;
}
