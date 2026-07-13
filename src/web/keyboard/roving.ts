// Roving DOM focus over rows marked [data-kbd-nav]. All helpers no-op when no
// such rows exist yet (Task 12 marks task rows), so movement commands are safe to
// wire now. "Focused" = the nav row that is or contains document.activeElement.

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

// Fire a row's inline action button ([data-kbd-action="toggle"|"delete"]); no-op
// when the focused row has none.
export function actOnFocused(action: "toggle" | "delete"): void {
	const items = navItems();
	const i = currentIndex(items);
	if (i < 0) return;
	items[i].querySelector<HTMLElement>(`[data-kbd-action="${action}"]`)?.click();
}
