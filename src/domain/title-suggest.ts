// Title suggestions drawn from titles the user has already written. Pure, and
// deliberately client-side over rows Zero has already synced: no new table, no
// new query, and nothing is suggested that the caller could not already read.

export type TitleCandidate = { title: string; listId: string };

/** Below this a query matches so much that the list is noise, not help. */
export const MIN_QUERY_LENGTH = 2;
export const DEFAULT_SUGGESTION_LIMIT = 5;

function normalize(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function suggestTitles(
	query: string,
	candidates: readonly TitleCandidate[],
	options: { listId?: string; limit?: number } = {},
): string[] {
	const q = normalize(query);
	if (q.length < MIN_QUERY_LENGTH) return [];
	const limit = options.limit ?? DEFAULT_SUGGESTION_LIMIT;

	const scored: { title: string; key: string; rank: number }[] = [];
	for (const candidate of candidates) {
		const key = normalize(candidate.title);
		// An exact match has nothing left to complete, so offering it is a
		// no-op row that pushes a real suggestion off the end of the list.
		if (key.length === 0 || key === q) continue;
		const at = key.indexOf(q);
		if (at < 0) continue;
		// Same list first, then prefix over mid-word: a shopping list's own
		// history is what the user is most likely reaching for.
		const sameList =
			options.listId !== undefined && candidate.listId === options.listId;
		scored.push({
			title: candidate.title.trim(),
			key,
			rank: (sameList ? 0 : 2) + (at === 0 ? 0 : 1),
		});
	}

	scored.sort(
		(a, b) =>
			a.rank - b.rank ||
			a.key.length - b.key.length ||
			(a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
	);

	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of scored) {
		if (seen.has(item.key)) continue;
		seen.add(item.key);
		out.push(item.title);
		if (out.length >= limit) break;
	}
	return out;
}
