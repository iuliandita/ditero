export function listRowsLoading({
	listId,
	lists,
	tasks,
	listsType,
	tasksType,
}: {
	listId: string;
	lists: readonly { id: string }[];
	tasks: readonly { listId: string; parentId?: string | null }[];
	listsType: "unknown" | "complete" | "error";
	tasksType: "unknown" | "complete" | "error";
}): boolean {
	if (listsType === "error" || tasksType === "error") return true;
	if (listsType === "complete" && tasksType === "complete") return false;
	return (
		!lists.some((list) => list.id === listId) ||
		!tasks.some((task) => task.listId === listId && task.parentId == null)
	);
}
