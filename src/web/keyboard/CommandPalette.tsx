import { useQuery } from "@rocicorp/zero/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { searchTasks } from "../../domain/search.ts";
import { m } from "../../paraglide/messages.js";
import { queries } from "../../zero/queries.ts";
import { useDashboards } from "../hooks/useDashboards.ts";
import { useViews } from "../hooks/useViews.ts";
import { BUILTIN_VIEWS } from "../views/builtins.ts";
import { useCommands } from "./CommandContext.tsx";
import { COMMANDS } from "./commands.ts";

// Flattened, keyboard-navigable palette item. `run()` fires on Enter/click; the
// caller closes afterwards.
type Item = { key: string; label: string; hint?: string; run: () => void };
type Group = { heading: string; items: Item[] };

export function CommandPalette({
	onNavigateList,
	onNavigateView,
	onNavigateDashboard,
}: {
	onNavigateList: (listId: string) => void;
	onNavigateView: (viewId: string) => void;
	onNavigateDashboard: (dashboardId: string) => void;
}) {
	const { isOpen, close, run } = useCommands();
	const [lists] = useQuery(queries.lists.mine());
	const [tasks] = useQuery(queries.tasks.mine());
	const { views } = useViews();
	const { dashboards } = useDashboards();

	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const [lastQuery, setLastQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	// Ignore mousemove events that don't actually move the pointer (e.g. a
	// re-render shifting a row under a stationary cursor) so hover never steals the
	// highlight from keyboard nav.
	const lastPointer = useRef({ x: -1, y: -1 });
	const baseId = useId();
	const listboxId = `${baseId}-listbox`;
	const optionId = (index: number) => `${baseId}-opt-${index}`;

	// Reset query + highlight each time the palette opens, and focus the input.
	useEffect(() => {
		if (!isOpen) return;
		setQuery("");
		setActive(0);
		const id = requestAnimationFrame(() => inputRef.current?.focus());
		return () => cancelAnimationFrame(id);
	}, [isOpen]);

	const q = query.trim().toLowerCase();
	const searchLists = useMemo(
		() => lists.map((l) => ({ id: l.id, title: l.title })),
		[lists],
	);

	const groups = useMemo<Group[]>(() => {
		const result: Group[] = [];

		// Commands: substring match on label (all when the query is empty).
		const cmdItems: Item[] = COMMANDS.filter(
			(c) => q === "" || c.label.toLowerCase().includes(q),
		).map((c) => ({
			key: `cmd:${c.id}`,
			label: c.label,
			run: () => run(c.id),
		}));
		if (cmdItems.length)
			result.push({ heading: m.palette_group_commands(), items: cmdItems });

		// Navigate: lists + built-in views + saved views. Views open the renderer.
		const navItems: Item[] = [];
		for (const l of lists) {
			if (q !== "" && !l.title.toLowerCase().includes(q)) continue;
			navItems.push({
				key: `list:${l.id}`,
				label: l.title,
				run: () => onNavigateList(l.id),
			});
		}
		for (const v of BUILTIN_VIEWS) {
			if (q !== "" && !v.name.toLowerCase().includes(q)) continue;
			navItems.push({
				key: `builtin:${v.id}`,
				label: v.name,
				run: () => onNavigateView(v.id),
			});
		}
		for (const v of views) {
			if (q !== "" && !v.name.toLowerCase().includes(q)) continue;
			navItems.push({
				key: `view:${v.id}`,
				label: v.name,
				run: () => onNavigateView(v.id),
			});
		}
		for (const d of dashboards) {
			// Match the raw name, not the decorated label: filtering on the
			// translated prefix would make the search string locale-dependent.
			if (q !== "" && !d.name.toLowerCase().includes(q)) continue;
			navItems.push({
				key: `dashboard:${d.id}`,
				label: m.palette_dashboard_item({ name: d.name }),
				run: () => onNavigateDashboard(d.id),
			});
		}
		if (navItems.length)
			result.push({ heading: m.palette_group_navigate(), items: navItems });

		// Search: only on a non-empty query (searchTasks returns [] otherwise).
		if (q !== "") {
			const listTitles = new Map(lists.map((l) => [l.id, l.title]));
			const hits = searchTasks(
				query,
				tasks.map((t) => ({
					id: t.id,
					listId: t.listId,
					title: t.title,
					notes: t.notes ?? null,
				})),
				searchLists,
			);
			const searchItems: Item[] = hits.map((h) => {
				const task = tasks.find((t) => t.id === h.taskId);
				const listTitle =
					listTitles.get(h.listId) ?? m.list_untitled_fallback();
				return {
					key: `task:${h.taskId}`,
					label: task?.title ?? m.palette_untitled_task(),
					hint: listTitle,
					run: () => onNavigateList(h.listId),
				};
			});
			if (searchItems.length)
				result.push({ heading: m.palette_group_search(), items: searchItems });
		}

		return result;
	}, [
		q,
		query,
		lists,
		tasks,
		views,
		dashboards,
		searchLists,
		run,
		onNavigateList,
		onNavigateView,
		onNavigateDashboard,
	]);

	const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

	// Any query change re-ranks results, so re-highlight the first row (standard
	// palette behavior) rather than leaving the highlight on a now-different item.
	// Render-time reset (React's documented "adjust state on value change" pattern).
	if (q !== lastQuery) {
		setLastQuery(q);
		setActive(0);
	}

	// Clamp if live data shrinks the result set without a query change.
	useEffect(() => {
		setActive((a) => (a >= flat.length ? 0 : a));
	}, [flat.length]);

	const activeOptionId =
		flat.length > 0 && active < flat.length ? optionId(active) : undefined;

	function activate(item: Item | undefined) {
		if (!item) return;
		item.run();
		close();
	}

	// Unmounted outright when closed rather than left to Radix's exit animation.
	// A closing layer stays mounted for the whole animation and still claims
	// Escape, so any command that opens another surface (quick-add, new view,
	// cheat sheet) left the palette swallowing the first Escape aimed at that
	// surface (#19). Dropping the subtree ends the layer in the same commit.
	// Suppressing the animation in CSS does not work here: tw-animate-css's
	// `animate-out` outranks `animate-none` in the cascade.
	if (!isOpen) return null;

	return (
		<Dialog open onOpenChange={(o) => !o && close()}>
			<DialogContent
				showCloseButton={false}
				aria-describedby={undefined}
				data-testid="command-palette"
				className="top-24 max-w-lg translate-y-0 gap-0 p-0 sm:max-w-lg"
				onKeyDown={(e) => {
					if (e.key === "ArrowDown") {
						e.preventDefault();
						setActive((a) => (flat.length ? (a + 1) % flat.length : 0));
					} else if (e.key === "ArrowUp") {
						e.preventDefault();
						setActive((a) =>
							flat.length ? (a - 1 + flat.length) % flat.length : 0,
						);
					} else if (e.key === "Enter") {
						e.preventDefault();
						activate(flat[active]);
					}
				}}
			>
				<DialogTitle className="sr-only">{m.palette_title()}</DialogTitle>
				<div className="border-b p-2">
					<Input
						ref={inputRef}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={m.palette_search_placeholder()}
						aria-label={m.palette_search_label()}
						role="combobox"
						aria-expanded={flat.length > 0}
						aria-controls={listboxId}
						aria-activedescendant={activeOptionId}
						className="h-9 border-0 focus-visible:ring-0"
					/>
				</div>
				<div
					id={listboxId}
					role="listbox"
					aria-label={m.palette_results_label()}
					className="max-h-80 overflow-y-auto p-1"
				>
					{flat.length === 0 ? (
						<p className="px-2 py-6 text-center text-sm text-muted-foreground">
							{m.palette_no_results()}
						</p>
					) : (
						groups.map((group) => (
							<div key={group.heading} className="mb-1">
								<div className="px-2 py-1 text-xs font-medium text-muted-foreground">
									{group.heading}
								</div>
								{group.items.map((item) => {
									const index = flat.indexOf(item);
									const isActive = index === active;
									return (
										<button
											key={item.key}
											id={optionId(index)}
											type="button"
											role="option"
											aria-selected={isActive}
											data-active={isActive}
											onMouseMove={(e) => {
												if (
													e.clientX === lastPointer.current.x &&
													e.clientY === lastPointer.current.y
												)
													return;
												lastPointer.current = { x: e.clientX, y: e.clientY };
												setActive(index);
											}}
											onClick={() => activate(item)}
											className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm data-[active=true]:bg-muted"
										>
											<span className="truncate">{item.label}</span>
											{item.hint && (
												<span className="ms-auto shrink-0 text-xs text-muted-foreground">
													{item.hint}
												</span>
											)}
										</button>
									);
								})}
							</div>
						))
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
