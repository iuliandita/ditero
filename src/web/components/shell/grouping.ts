import type { Folder, List } from "../../../zero/schema.gen.ts";

export type ListGroup = { folder: Folder | null; lists: List[] };

const bySortKey = (a: { sortKey: string }, b: { sortKey: string }) =>
	a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;

// Group a workspace's lists under their folders (folders ordered by sortKey),
// with the ungrouped bucket last. Lists inside each group are sortKey-ordered.
export function groupLists(folders: Folder[], lists: List[]): ListGroup[] {
	const sortedFolders = [...folders].sort(bySortKey);
	const groups: ListGroup[] = sortedFolders.map((folder) => ({
		folder,
		lists: lists.filter((l) => l.folderId === folder.id).sort(bySortKey),
	}));
	const ungrouped = lists.filter((l) => l.folderId == null).sort(bySortKey);
	if (ungrouped.length > 0) groups.push({ folder: null, lists: ungrouped });
	return groups;
}
