import type { ContentOptions, ContentProvider } from "./content-common.ts";
import { parseGenericCsv } from "./generic-csv.ts";
import { parseMicrosoftTodoCsv } from "./microsoft-todo.ts";
import { parseTickTickBackup } from "./ticktick.ts";
import { parseTodoistContent } from "./todoist-content.ts";
import { parseTrelloContent } from "./trello-content.ts";

export function parseContentProvider(
	provider: ContentProvider,
	bytes: Uint8Array,
	options: ContentOptions,
) {
	switch (provider) {
		case "todoist":
			return parseTodoistContent(bytes, options);
		case "ticktick":
			return parseTickTickBackup(bytes, options);
		case "microsoft":
			return parseMicrosoftTodoCsv(bytes, options);
		case "trello":
			return parseTrelloContent(bytes, options);
		case "generic-csv":
			return parseGenericCsv(bytes, options);
	}
}
