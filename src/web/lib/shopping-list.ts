// Shape of a shopping row shared by the list and its tests. Pure.

type Categorized = { category?: string | null };

export const UNCATEGORIZED = "";

// First-seen category order among (already sort-key-ordered) items; the
// uncategorized bucket is always emitted last. Headers only earn their space
// when at least one item has a real category: a list with none is one plain
// run of items, not a lone "Other" group.
export function groupByCategory<T extends Categorized>(
	items: T[],
): { groups: [string, T[]][]; showHeaders: boolean } {
	const map = new Map<string, T[]>();
	for (const item of items) {
		const key = item.category?.trim()
			? (item.category as string)
			: UNCATEGORIZED;
		const bucket = map.get(key);
		if (bucket) bucket.push(item);
		else map.set(key, [item]);
	}
	const groups = [...map.entries()];
	groups.sort((a, b) => {
		if (a[0] === UNCATEGORIZED) return 1;
		if (b[0] === UNCATEGORIZED) return -1;
		return 0;
	});
	return {
		groups,
		showHeaders: groups.some(([key]) => key !== UNCATEGORIZED),
	};
}

// "2 L", "3", or "kg" -- empty when neither part is set.
export function formatAmount(
	quantity: string | null | undefined,
	unit: string | null | undefined,
): string {
	return [quantity?.trim(), unit?.trim()].filter(Boolean).join(" ");
}
