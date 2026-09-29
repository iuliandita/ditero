import { Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ListIcon } from "@/lib/list-icon";
import { dashboardIcon, FolderIcon, viewIcon } from "@/lib/nav-icon";
import type { NavSection } from "@/lib/nav-sections";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import type { ListKind } from "../../../domain/icon-map.ts";
import { m } from "../../../paraglide/messages.js";
import type { Dashboard, List } from "../../../zero/schema.gen.ts";
import type { SavedView } from "../../hooks/useViews.ts";
import type { BuiltinView } from "../../views/builtins.ts";
import { SortableList } from "../list/SortableList.tsx";
import { Button } from "../ui/button.tsx";
import type { ListGroup } from "./grouping.ts";
import { ListProgress } from "./ListProgress.tsx";
import { EmptyFolder, NavGroup } from "./Sidebar.tsx";

const ROW =
	"flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-start text-sm transition-colors duration-(--motion-fast) ease-(--motion-ease) hover:bg-muted active:bg-muted motion-reduce:transition-none";
const CREATE_ROW = cn(ROW, "text-muted-foreground");

// The mobile Lists tab: the same order and grouping as the desktop sidebar,
// minus Today, which has its own tab.
export function MobileListIndex({
	createList,
	groups,
	progressByList,
	canEditList,
	onMoveList,
	onOpenList,
	canCreateList,
	onNewListInFolder,
	views,
	pinnedViews,
	onOpenView,
	onNewView,
	dashboards,
	onOpenDashboard,
	onNewDashboard,
	isSectionOpen,
	onToggleSection,
}: {
	createList: ReactNode;
	groups: ListGroup[];
	progressByList: Map<string, { done: number; total: number }>;
	canEditList: (id: string) => boolean;
	onMoveList: (id: string, sortKey: string) => void;
	onOpenList: (id: string) => void;
	canCreateList: boolean;
	onNewListInFolder: (folderId: string) => void;
	views: BuiltinView[];
	pinnedViews: SavedView[];
	onOpenView: (id: string) => void;
	onNewView: () => void;
	dashboards: Dashboard[];
	onOpenDashboard: (id: string) => void;
	onNewDashboard: () => void;
	isSectionOpen: (section: NavSection) => boolean;
	onToggleSection: (section: NavSection) => void;
}) {
	// Touch drags from a grip that only exists in reorder mode, as on a list
	// page (#369): outside it the grips stay out of the way of taps, and the
	// keyboard still reorders from a focused grip.
	const coarse = useMediaQuery("(pointer: coarse)");
	const [reordering, setReordering] = useState(false);
	const listCount = groups.reduce((n, g) => n + g.lists.length, 0);
	const canReorder =
		coarse &&
		listCount > 1 &&
		groups.some((g) => g.lists.some((l) => canEditList(l.id)));
	const reorderActive = reordering && canReorder;
	const viewRow = (v: BuiltinView | SavedView) => {
		const Icon = viewIcon(v);
		return (
			<li key={v.id}>
				<button
					type="button"
					data-nav-kind="view"
					onClick={() => onOpenView(v.id)}
					className={ROW}
				>
					<Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
					<span className="truncate">{v.name}</span>
				</button>
			</li>
		);
	};
	const listItems = (lists: List[]) => (
		<SortableList
			items={lists}
			canDrag={canEditList}
			onMove={onMoveList}
			handleLabel={m.list_reorder_handle()}
			handleTestId="list-drag"
			className="gap-0.5"
			touch={reorderActive ? "reorder" : "hidden"}
			renderItem={(l) => (
				<button
					type="button"
					data-list-id={l.id}
					onClick={() => onOpenList(l.id)}
					className={ROW}
				>
					<ListIcon
						icon={l.icon}
						kind={(l.kind ?? "tasks") as ListKind}
						title={l.title}
					/>
					<span className="flex min-w-0 flex-1 flex-col">
						<span className="truncate">{l.title}</span>
						{l.kind === "project" && progressByList.has(l.id) && (
							<ListProgress
								done={progressByList.get(l.id)?.done ?? 0}
								total={progressByList.get(l.id)?.total ?? 0}
							/>
						)}
					</span>
				</button>
			)}
		/>
	);

	return (
		<div className="flex flex-col px-4 pb-4">
			<h1 className="sr-only">{m.nav_lists()}</h1>
			<ul className="flex flex-col gap-0.5" data-nav-group="primary">
				{views.map(viewRow)}
			</ul>

			<NavGroup title={m.sidebar_ungrouped_lists()} section="lists">
				<div className="mb-2 flex items-center gap-2">
					<div className="min-w-0 flex-1">{createList}</div>
					{canReorder && !reorderActive && (
						<Button
							variant="ghost"
							data-testid="list-reorder-mode"
							className="min-h-11 text-muted-foreground"
							onClick={() => setReordering(true)}
						>
							{m.list_reorder_mode()}
						</Button>
					)}
				</div>
				{reorderActive && (
					<div
						data-testid="list-reorder-bar"
						className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-muted ps-3 text-sm text-muted-foreground"
					>
						<span>{m.list_reorder_hint()}</span>
						<Button
							variant="ghost"
							className="min-h-11"
							onClick={() => setReordering(false)}
						>
							{m.list_reorder_done()}
						</Button>
					</div>
				)}
				<div data-testid="list-index" className="flex flex-col gap-2">
					{groups.map((group) =>
						group.folder ? (
							<div key={group.folder.id} data-folder-id={group.folder.id}>
								<div className="flex min-h-11 items-center gap-3 px-3 text-sm text-muted-foreground">
									<FolderIcon aria-hidden className="size-4 shrink-0" />
									<span className="truncate">{group.folder.name}</span>
								</div>
								<div className="ps-4">
									{group.lists.length > 0 ? (
										listItems(group.lists)
									) : (
										<EmptyFolder
											canCreate={canCreateList}
											onCreate={() => {
												if (group.folder) onNewListInFolder(group.folder.id);
											}}
											className="min-h-11 px-3 text-sm hover:bg-muted"
										/>
									)}
								</div>
							</div>
						) : (
							<div key="__ungrouped__">{listItems(group.lists)}</div>
						),
					)}
				</div>
			</NavGroup>

			<NavGroup
				title={m.sidebar_views_heading()}
				section="views"
				open={isSectionOpen("views")}
				onToggle={() => onToggleSection("views")}
				touch
			>
				<ul className="flex flex-col gap-0.5">
					{pinnedViews.map(viewRow)}
					<li>
						<button
							type="button"
							data-testid="new-view"
							onClick={onNewView}
							className={CREATE_ROW}
						>
							<Plus aria-hidden className="size-4 shrink-0" />
							{m.action_new_view()}
						</button>
					</li>
				</ul>
			</NavGroup>

			<NavGroup
				title={m.sidebar_dashboards_heading()}
				section="dashboards"
				open={isSectionOpen("dashboards")}
				onToggle={() => onToggleSection("dashboards")}
				touch
			>
				<ul className="flex flex-col gap-0.5">
					{dashboards.map((d) => {
						const Icon = dashboardIcon(d);
						return (
							<li key={d.id}>
								<button
									type="button"
									data-nav-kind="dashboard"
									onClick={() => onOpenDashboard(d.id)}
									className={ROW}
								>
									<Icon
										aria-hidden
										className="size-4 shrink-0 text-muted-foreground"
									/>
									<span className="truncate">{d.name}</span>
								</button>
							</li>
						);
					})}
					<li>
						<button
							type="button"
							data-testid="new-dashboard"
							onClick={onNewDashboard}
							className={CREATE_ROW}
						>
							<Plus aria-hidden className="size-4 shrink-0" />
							{m.action_new_dashboard()}
						</button>
					</li>
				</ul>
			</NavGroup>
		</div>
	);
}
