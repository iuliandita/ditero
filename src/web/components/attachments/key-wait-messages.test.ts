import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// The expired-wait message is shown by the attachment list and the comment
// composer. Only the list asks for a new pick; in the composer the files stay
// attached and Send restarts the wait, so the text must not tell people to pick.
const PICK_AGAIN: Record<string, string> = {
	ar: "اختر الملف",
	de: "Wähle die Datei",
	en: "Pick the file",
	es: "elegir el archivo",
	fr: "Choisis à nouveau le fichier",
	ro: "Alege din nou fișierul",
};

test.each(
	Object.entries(PICK_AGAIN),
)("%s expired-wait message fits both surfaces", (locale, phrase) => {
	const catalog = JSON.parse(
		readFileSync(`messages/${locale}.json`, "utf8"),
	) as Record<string, string>;
	expect(catalog.attachment_key_wait_expired).toBeTruthy();
	expect(catalog.attachment_key_wait_expired).not.toContain(phrase);
});
