export type SearchHit = {
	taskId: string;
	listId: string;
	matchedField: "title" | "notes" | "list";
};

type SearchTask = {
	id: string;
	listId: string;
	title: string;
	notes: string | null;
};

// title=3 > list=2 > notes=1: best hit per task wins.
const FIELD_SCORE = { title: 3, list: 2, notes: 1 } as const;

export function searchTasks(
	query: string,
	tasks: SearchTask[],
	lists: { id: string; title: string }[],
): SearchHit[] {
	const q = query.trim().toLowerCase();
	if (q === "") return [];

	const listTitles = new Map(lists.map((l) => [l.id, l.title]));

	const scored: { hit: SearchHit; score: number; title: string }[] = [];
	for (const t of tasks) {
		const listTitle = listTitles.get(t.listId);
		let field: SearchHit["matchedField"] | null = null;
		if (t.title.toLowerCase().includes(q)) field = "title";
		else if (listTitle?.toLowerCase().includes(q)) field = "list";
		else if (t.notes?.toLowerCase().includes(q)) field = "notes";
		if (field === null) continue;
		scored.push({
			hit: { taskId: t.id, listId: t.listId, matchedField: field },
			score: FIELD_SCORE[field],
			title: t.title,
		});
	}

	scored.sort(
		(a, b) =>
			b.score - a.score || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0),
	);
	return scored.map((s) => s.hit);
}
