// Command-category labels over the compiled Paraglide `m`, shared by the cheat
// sheet and the keymap settings so the closed set is mapped once. Thunks, not
// resolved strings: this map is module-level, so calling `m` here would freeze
// every label at the import-time locale. The Object.hasOwn guard keeps a
// prototype key ("constructor") from resolving to a non-message.
import { m } from "../../paraglide/messages.js";

const CATEGORY_LABELS: Record<string, () => string> = {
	general: m.cheatsheet_category_general,
	task: m.cheatsheet_category_task,
	view: m.cheatsheet_category_view,
	nav: m.cheatsheet_category_nav,
	help: m.cheatsheet_category_help,
};

export function categoryLabel(category: string): string {
	return Object.hasOwn(CATEGORY_LABELS, category)
		? CATEGORY_LABELS[category]()
		: category;
}
