// Purely lexical @handle extraction from a comment/notes body. A handle starts
// with a letter or digit and may then contain letters, digits, `.`, `_`, `-`.
// The `@` must sit at a left word boundary (`(?<![\w@])`) so emails like
// `a@b.com` and mid-word `foo@bar` are not mentions. Case is preserved and
// dedup is exact (first-seen order). Resolving a handle to a user is the UI's
// job; this never touches identity and never throws.
const MENTION_RE = /(?<![\w@])@([a-z0-9][a-z0-9._-]*)/gi;

export function firstToken(name: string): string {
	return name.trim().split(/\s+/)[0] ?? "";
}

// A parsed handle resolves to a person when it equals their first name token or
// their whitespace-stripped full name (case-insensitive). MENTION_RE cannot
// match whitespace, so a multi-word display name is reachable only through one
// of these two forms -- matching on the raw name would make every user whose
// name contains a space unmentionable.
export function personMatchesHandle(name: string, handle: string): boolean {
	const h = handle.toLowerCase();
	return (
		firstToken(name).toLowerCase() === h ||
		name.replace(/\s+/g, "").toLowerCase() === h
	);
}

export function parseMentions(body: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of body.matchAll(MENTION_RE)) {
		const handle = m[1];
		if (!seen.has(handle)) {
			seen.add(handle);
			out.push(handle);
		}
	}
	return out;
}
