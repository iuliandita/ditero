import { useEffect, useRef, useState } from "react";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { searchTasks } from "../../../domain/search.ts";
import { m } from "../../../paraglide/messages.js";
import type { List, Task } from "../../../zero/schema.gen.ts";
import { Input } from "../ui/input.tsx";

// Touch counterpart to the ⌘K palette's Search group: same client-side predicate
// over the same synced rows, on a surface a thumb can reach. The palette itself
// is desktop-only (design 2.18) -- it leads with the keyboard command registry.
export function MobileSearch({
	tasks,
	lists,
	onSelect,
	onClose,
}: {
	tasks: readonly Task[];
	lists: readonly List[];
	onSelect: (taskId: string, listId: string) => void;
	onClose: () => void;
}) {
	const [query, setQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const id = requestAnimationFrame(() => inputRef.current?.focus());
		return () => cancelAnimationFrame(id);
	}, []);

	const listTitles = new Map(lists.map((l) => [l.id, l.title]));
	const hits = searchTasks(
		query,
		tasks.map((t) => ({
			id: t.id,
			listId: t.listId,
			title: t.title,
			notes: t.notes ?? null,
		})),
		lists.map((l) => ({ id: l.id, title: l.title })),
	);

	return (
		<Sheet open onOpenChange={(o) => !o && onClose()}>
			<SheetContent
				side="bottom"
				aria-describedby={undefined}
				data-testid="mobile-search"
				className="h-[85dvh] gap-0 p-0"
			>
				{/* Same string as the tab that opens it -- one key, not two. */}
				<SheetHeader className="pb-2">
					<SheetTitle>{m.nav_search()}</SheetTitle>
				</SheetHeader>
				<div className="px-4 pb-3">
					<Input
						ref={inputRef}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						type="search"
						placeholder={m.search_placeholder()}
						aria-label={m.search_placeholder()}
						data-testid="mobile-search-input"
						className="h-11"
					/>
				</div>
				{query.trim() === "" ? (
					<p className="px-4 text-sm text-muted-foreground">
						{m.search_hint()}
					</p>
				) : hits.length === 0 ? (
					<p className="px-4 text-sm text-muted-foreground">
						{m.palette_no_results()}
					</p>
				) : (
					<ul
						aria-label={m.palette_results_label()}
						className="flex-1 overflow-y-auto px-2 pb-[env(safe-area-inset-bottom)]"
					>
						{hits.map((hit) => {
							const task = tasks.find((t) => t.id === hit.taskId);
							return (
								<li key={hit.taskId}>
									<button
										type="button"
										data-testid="mobile-search-result"
										onClick={() => onSelect(hit.taskId, hit.listId)}
										className="flex min-h-11 w-full flex-col justify-center gap-0.5 rounded-lg px-2 py-2 text-start active:bg-muted/60"
									>
										<span className="truncate text-sm">
											{task?.title ?? m.palette_untitled_task()}
										</span>
										<span className="truncate text-xs text-muted-foreground">
											{listTitles.get(hit.listId) ?? m.list_untitled_fallback()}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</SheetContent>
		</Sheet>
	);
}
