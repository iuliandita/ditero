// Roving DOM focus over task rows: TaskRow marks its open button [data-kbd-nav]
// and its row container [data-kbd-row]. All helpers no-op when no such rows are
// present. "Focused" = the nav element that is or contains document.activeElement.

function navItems(): HTMLElement[] {
	return Array.from(document.querySelectorAll<HTMLElement>("[data-kbd-nav]"));
}

function currentIndex(items: HTMLElement[]): number {
	const active = document.activeElement;
	if (!active) return -1;
	return items.findIndex((el) => el === active || el.contains(active));
}

export function focusNext(): void {
	const items = navItems();
	if (items.length === 0) return;
	const i = currentIndex(items);
	items[i < 0 ? 0 : Math.min(i + 1, items.length - 1)].focus();
}

export function focusPrev(): void {
	const items = navItems();
	if (items.length === 0) return;
	const i = currentIndex(items);
	items[i < 0 ? items.length - 1 : Math.max(i - 1, 0)].focus();
}

export function openFocused(): void {
	const items = navItems();
	const i = currentIndex(items);
	if (i < 0) return;
	items[i].click();
}

// Fire the focused row's inline control for `action` ([data-kbd-action="..."]),
// resolved from the row container so a sibling control (not a descendant of the
// nav element) still matches. No-op when the focused row has none. Menu ITEMS
// are unreachable this way -- Radix portals the menu content out of the row's
// subtree -- so "delete" targets a hidden in-row button, not the menu entry.
export function actOnFocused(action: "toggle" | "delete" | "menu"): void {
	const items = navItems();
	const i = currentIndex(items);
	if (i < 0) return;
	const row = items[i].closest<HTMLElement>("[data-kbd-row]") ?? items[i];
	row.querySelector<HTMLElement>(`[data-kbd-action="${action}"]`)?.click();
}
