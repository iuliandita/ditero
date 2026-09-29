import { useQuery, useZero } from "@rocicorp/zero/react";
import { Circle, LayoutDashboard, type LucideIcon, Search } from "lucide-react";
import {
	type ReactNode,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ListKind } from "../../domain/icon-map.ts";
import { searchTasks } from "../../domain/search.ts";
import { m } from "../../paraglide/messages.js";
import { queries } from "../../zero/queries.ts";
import type { List, schema } from "../../zero/schema.gen.ts";
import { useDashboards } from "../hooks/useDashboards.ts";
import { useViews } from "../hooks/useViews.ts";
import { ICONS, ListIcon } from "../lib/list-icon.tsx";
import { loadRecents } from "../lib/recents.ts";
import { BUILTIN_VIEWS } from "../views/builtins.ts";
import { formatBinding } from "./binding-label.ts";
import { useCommands } from "./CommandContext.tsx";
import { COMMANDS } from "./commands.ts";
import { useEffectiveKeymap } from "./useEffectiveKeymap.ts";

// Flattened, keyboard-navigable palette item. `run()` fires on Enter/click; the
// caller closes afterwards.
type Item = {
	key: string;
	label: string;
	icon: ReactNode;
	hint?: string;
	keys?: string;
	run: () => void;
};
type Group = { id: string; heading: string; items: Item[] };

// What the palette offers on open, before anything is typed.
const TOP_COMMANDS = [
	"task.create",
	"view.new",
	"dashboard.new",
	"help.cheatSheet",
	"settings.open",
];
// Row-relative commands act on the focused row, which the palette has just
// taken focus from; the palette itself is already open.
const NOT_IN_PALETTE: ReadonlySet<string> = new Set([
	"palette.open",
	"search.open",
	"nav.down",
	"nav.up",
	"nav.open",
	"task.toggleDone",
	"task.delete",
	"row.menu",
	"selection.toggle",
	"selection.extendDown",
	"selection.extendUp",
	"selection.all",
	"selection.clear",
]);
const EMPTY_LIMIT = 6;
const RECENT_LIMIT = 5;
const TASK_LIMIT = 8;

function glyph(Icon: LucideIcon) {
	return <Icon aria-hidden className="size-4 text-muted-foreground" />;
}

function viewGlyph(icon: string | null | undefined) {
	return icon && Object.hasOwn(ICONS, icon)
		? glyph(ICONS[icon])
		: glyph(Search);
}

export function CommandPalette({
	onNavigateList,
	onNavigateView,
	onNavigateDashboard,
	onOpenTask,
}: {
	onNavigateList: (listId: string) => void;
	onNavigateView: (viewId: string) => void;
	onNavigateDashboard: (dashboardId: string) => void;
	onOpenTask: (taskId: string, listId: string) => void;
}) {
	const zero = useZero<typeof schema>();
	const { isOpen, close, run } = useCommands();
	const [lists] = useQuery(queries.lists.mine());
	const [tasks] = useQuery(queries.tasks.mine());
	const { views } = useViews();
	const { dashboards } = useDashboards();
	const keymap = useEffectiveKeymap();

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

	// Read once per opening: recording happens elsewhere while it is closed.
	const recents = useMemo(
		() => (isOpen ? loadRecents(zero.userID) : []),
		[isOpen, zero.userID],
	);

	const q = query.trim().toLowerCase();

	const groups = useMemo<Group[]>(() => {
		const matches = (text: string) =>
			q === "" || text.toLowerCase().includes(q);
		const listById = new Map(lists.map((l) => [l.id, l]));
		const listItem = (l: List): Item => ({
			key: `list:${l.id}`,
			label: l.title,
			icon: (
				<ListIcon
					icon={l.icon}
					kind={(l.kind ?? "tasks") as ListKind}
					title={l.title}
				/>
			),
			run: () => onNavigateList(l.id),
		});
		const viewItems: Item[] = [
			...BUILTIN_VIEWS.map((v) => ({
				key: `view:${v.id}`,
				label: v.name,
				icon: viewGlyph(v.icon),
				run: () => onNavigateView(v.id),
			})),
			...views.map((v) => ({
				key: `view:${v.id}`,
				label: v.name,
				icon: viewGlyph(v.icon),
				run: () => onNavigateView(v.id),
			})),
		];
		// Matched on the raw name, not the decorated label: the translated prefix
		// would make the search string locale-dependent.
		const dashboardItems = dashboards.map((d) => ({
			name: d.name,
			item: {
				key: `dashboard:${d.id}`,
				label: m.palette_dashboard_item({ name: d.name }),
				icon: glyph(LayoutDashboard),
				run: () => onNavigateDashboard(d.id),
			} satisfies Item,
		}));
		const taskItem = (t: (typeof tasks)[number]): Item => ({
			key: `task:${t.id}`,
			label: t.title || m.palette_untitled_task(),
			icon: glyph(Circle),
			hint: listById.get(t.listId)?.title ?? m.list_untitled_fallback(),
			run: () => onOpenTask(t.id, t.listId),
		});
		const commandItems = COMMANDS.filter(
			(c) =>
				!NOT_IN_PALETTE.has(c.id) && (q !== "" || TOP_COMMANDS.includes(c.id)),
		)
			.filter((c) => matches(c.label))
			.map<Item>((c) => {
				const binding = keymap[c.id]?.[0];
				return {
					key: `cmd:${c.id}`,
					label: c.label,
					icon: null,
					keys: binding ? formatBinding(binding) : undefined,
					run: () => run(c.id),
				};
			});

		const result: Group[] = [];
		const push = (id: string, heading: string, items: Item[]) => {
			if (items.length) result.push({ id, heading, items });
		};

		if (q === "") {
			const byKey = new Map<string, Item>();
			for (const l of lists) byKey.set(`list:${l.id}`, listItem(l));
			for (const v of viewItems) byKey.set(v.key, v);
			for (const d of dashboardItems) byKey.set(d.item.key, d.item);
			const taskById = new Map(tasks.map((t) => [t.id, t]));
			const recentItems: Item[] = [];
			for (const r of recents) {
				if (r.kind === "task") {
					const t = taskById.get(r.id);
					if (t) recentItems.push(taskItem(t));
				} else {
					const item = byKey.get(`${r.kind}:${r.id}`);
					if (item) recentItems.push(item);
				}
				if (recentItems.length === RECENT_LIMIT) break;
			}
			const shown = new Set(recentItems.map((i) => i.key));
			push("recent", m.palette_group_recent(), recentItems);
			push(
				"lists",
				m.palette_group_lists(),
				lists
					.map(listItem)
					.filter((i) => !shown.has(i.key))
					.slice(0, EMPTY_LIMIT),
			);
			push(
				"views",
				m.palette_group_views(),
				[...viewItems, ...dashboardItems.map((d) => d.item)]
					.filter((i) => !shown.has(i.key))
					.slice(0, EMPTY_LIMIT),
			);
			push("commands", m.palette_group_commands(), commandItems);
			return result;
		}

		push(
			"lists",
			m.palette_group_lists(),
			lists.filter((l) => matches(l.title)).map(listItem),
		);
		push("views", m.palette_group_views(), [
			...viewItems.filter((v) => matches(v.label)),
			...dashboardItems.filter((d) => matches(d.name)).map((d) => d.item),
		]);
		const taskById = new Map(tasks.map((t) => [t.id, t]));
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
		const taskItems: Item[] = [];
		for (const h of hits) {
			const t = taskById.get(h.taskId);
			if (t) taskItems.push(taskItem(t));
			if (taskItems.length === TASK_LIMIT) break;
		}
		push("tasks", m.palette_group_tasks(), taskItems);
		push("commands", m.palette_group_commands(), commandItems);
		return result;
	}, [
		q,
		query,
		lists,
		tasks,
		views,
		dashboards,
		recents,
		keymap,
		run,
		onNavigateList,
		onNavigateView,
		onNavigateDashboard,
		onOpenTask,
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

	// Keep the highlighted row in view while arrowing through a long list.
	useEffect(() => {
		if (!isOpen) return;
		document
			.getElementById(optionId(active))
			?.scrollIntoView({ block: "nearest" });
	});

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
				className="top-24 translate-y-0 gap-0 p-0 sm:max-w-lg"
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
					className="max-h-[min(24rem,60dvh)] overflow-y-auto p-1"
				>
					{flat.length === 0 ? (
						<p className="px-2 py-6 text-center text-sm text-muted-foreground">
							{m.palette_no_results()}
						</p>
					) : (
						groups.map((group) => {
							const headingId = `${baseId}-group-${group.id}`;
							return (
								// biome-ignore lint/a11y/useSemanticElements: an option group inside a listbox, not a form fieldset
								<div
									key={group.id}
									role="group"
									aria-labelledby={headingId}
									data-testid={`palette-group-${group.id}`}
									className="pb-1 not-first:pt-1"
								>
									<div
										id={headingId}
										className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground"
									>
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
												tabIndex={-1}
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
												className="flex min-h-9 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start text-sm data-[active=true]:bg-muted"
											>
												{item.icon !== null && (
													<span className="flex size-4 shrink-0 items-center justify-center">
														{item.icon}
													</span>
												)}
												<span className="min-w-0 truncate">{item.label}</span>
												{item.hint && (
													<span className="ms-auto min-w-0 shrink truncate ps-2 text-xs text-muted-foreground">
														{item.hint}
													</span>
												)}
												{item.keys && (
													<kbd
														aria-hidden
														className="ms-auto shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
													>
														{item.keys}
													</kbd>
												)}
											</button>
										);
									})}
								</div>
							);
						})
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
