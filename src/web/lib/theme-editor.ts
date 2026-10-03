import {
	type ThemeDocument,
	validateThemeDocument,
} from "../../domain/theme-document.ts";
import {
	MAX_CUSTOM_THEMES,
	type ThemeLibrary,
	validateThemeLibrary,
} from "./theme-documents.ts";

export function saveEditedTheme(
	library: ThemeLibrary,
	sourceId: string,
	document: ThemeDocument,
	newId: string,
): ThemeLibrary {
	const validated = validateThemeDocument(document);
	const existing = library.documents.some((entry) => entry.id === sourceId);
	if (!existing && library.documents.length >= MAX_CUSTOM_THEMES)
		throw new Error("Theme library is full");
	const selected = existing ? sourceId : newId;
	const documents = existing
		? library.documents.map((entry) =>
				entry.id === sourceId ? { id: sourceId, document: validated } : entry,
			)
		: [...library.documents, { id: selected, document: validated }];
	return validateThemeLibrary({ selected, useAccent: false, documents });
}
