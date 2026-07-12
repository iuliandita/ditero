import { PanelLeft, PanelLeftClose, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ListIcon } from "@/lib/list-icon";
import { cn } from "@/lib/utils";
import type { ListKind } from "../../../domain/icon-map.ts";
import type { Workspace } from "../../../zero/schema.gen.ts";
import type { Section } from "./BottomNav.tsx";
import type { ListGroup } from "./grouping.ts";
import { ListProgress } from "./ListProgress.tsx";

// Persistent desktop rail (280px, collapsible to a 64px icon rail). Top:
// workspace switcher. Middle: folder/list tree with per-kind icons + accent.
// Bottom: Settings, pinned. Built-in views (Today/All/Assigned) land later.
export function Sidebar({
	workspaces,
	activeId,
	onSelectWorkspace,
	onOpenShared,
	groups,
	progressByList,
	openListId,
	onOpenList,
	section,
	onOpenSettings,
	collapsed,
	onToggleCollapsed,
}: {
	workspaces: Workspace[];
	activeId: string | null;
	onSelectWorkspace: (id: string) => void;
	onOpenShared: () => void;
	groups: ListGroup[];
	progressByList: Map<string, { done: number; total: number }>;
	openListId: string | null;
	onOpenList: (id: string) => void;
	section: Section;
	onOpenSettings: () => void;
	collapsed: boolean;
	onToggleCollapsed: () => void;
}) {
	return (
		<aside
			className={cn(
				"sticky top-0 flex h-dvh flex-col border-e bg-sidebar text-sidebar-foreground",
				collapsed ? "w-16" : "w-[280px]",
			)}
		>
			<div className="flex flex-col gap-1 border-b p-2">
				{!collapsed &&
					workspaces.map((w) => (
						<button
							key={w.id}
							type="button"
							aria-current={w.id === activeId ? "true" : undefined}
							onClick={() => onSelectWorkspace(w.id)}
							className={cn(
								"truncate rounded-lg px-2 py-1.5 text-start text-sm",
								w.id === activeId
									? "bg-sidebar-accent font-medium"
									: "text-muted-foreground hover:bg-sidebar-accent/60",
							)}
						>
							{w.name}
						</button>
					))}
				<Button
					data-testid="open-shared"
					variant="ghost"
					size="sm"
					className={cn("justify-start", collapsed && "justify-center px-0")}
					onClick={onOpenShared}
				>
					{collapsed ? "S" : "Open shared"}
				</Button>
			</div>

			<nav className="flex-1 overflow-y-auto p-2" aria-label="Lists">
				{groups.map((group) => (
					<div key={group.folder?.id ?? "__ungrouped__"} className="mb-3">
						{!collapsed && (
							<div className="px-2 py-1 text-xs font-medium text-muted-foreground">
								{group.folder?.name ?? "Lists"}
							</div>
						)}
						<ul className="flex flex-col gap-0.5">
							{group.lists.map((l) => (
								<li key={l.id}>
									<button
										type="button"
										aria-current={
											l.id === openListId && section === "lists"
												? "page"
												: undefined
										}
										onClick={() => onOpenList(l.id)}
										title={l.title}
										className={cn(
											"flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm",
											l.id === openListId && section === "lists"
												? "bg-sidebar-accent font-medium"
												: "hover:bg-sidebar-accent/60",
											collapsed && "justify-center px-0",
										)}
									>
										<ListIcon
											icon={l.icon}
											kind={(l.kind ?? "tasks") as ListKind}
											title={l.title}
										/>
										{!collapsed && (
											<span className="flex min-w-0 flex-1 flex-col">
												<span className="truncate">{l.title}</span>
												{l.kind === "project" && progressByList.has(l.id) && (
													<ListProgress
														done={progressByList.get(l.id)?.done ?? 0}
														total={progressByList.get(l.id)?.total ?? 0}
													/>
												)}
											</span>
										)}
									</button>
								</li>
							))}
						</ul>
					</div>
				))}
			</nav>

			<div className="flex items-center gap-1 border-t p-2">
				<Button
					variant={section === "settings" ? "secondary" : "ghost"}
					size="sm"
					className={cn(
						"flex-1 justify-start",
						collapsed && "justify-center px-0",
					)}
					onClick={onOpenSettings}
				>
					<Settings className="size-4" />
					{!collapsed && "Settings"}
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
					onClick={onToggleCollapsed}
				>
					{collapsed ? (
						<PanelLeft className="size-4" />
					) : (
						<PanelLeftClose className="size-4" />
					)}
				</Button>
			</div>
		</aside>
	);
}
