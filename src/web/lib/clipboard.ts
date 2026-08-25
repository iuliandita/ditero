// navigator.clipboard is gated to secure contexts, so on a plain-HTTP origin
// that is not localhost it is undefined -- the way a self-hoster first reaches
// the app on a LAN address. Copying an invite link is how sharing works, so it
// falls back to the selection-based path, which carries no such gate.

type Writer = { writeText(text: string): Promise<void> };

export type ClipboardDeps = {
	// Read through getters so a module import never touches the DOM.
	writer?: Writer | undefined;
	doc?: Document;
};

function legacyCopy(text: string, doc: Document): boolean {
	const field = doc.createElement("textarea");
	field.value = text;
	field.setAttribute("readonly", "");
	// Off-screen rather than hidden: a display:none or visibility:hidden field
	// cannot hold a selection, so the copy silently yields an empty clipboard.
	field.style.position = "fixed";
	field.style.top = "-1000px";
	field.style.opacity = "0";
	doc.body.appendChild(field);
	try {
		field.select();
		return doc.execCommand("copy");
	} catch {
		return false;
	} finally {
		field.remove();
	}
}

// Resolves false when the text did not reach the clipboard, so callers can
// avoid reporting a copy that never happened.
export async function copyText(
	text: string,
	deps: ClipboardDeps = {},
): Promise<boolean> {
	const writer =
		"writer" in deps
			? deps.writer
			: (globalThis.navigator?.clipboard ?? undefined);
	const doc = deps.doc ?? globalThis.document;
	if (writer) {
		try {
			await writer.writeText(text);
			return true;
		} catch {
			// Permission denied or a detached document: the legacy path may still
			// work, and giving up here would look like a broken button.
		}
	}
	if (!doc) return false;
	return legacyCopy(text, doc);
}
