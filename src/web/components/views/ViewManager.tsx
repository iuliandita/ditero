import { type JSX, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { useIsDesktop } from "@/lib/use-media-query";
import type {
	FilterGroup,
	GroupBy,
	ViewDisplay,
	ViewLayout,
	WorkspaceScope,
} from "../../../domain/view-filter.ts";
import { FilterBuilder } from "./FilterBuilder.tsx";

// Assembled form output; the caller (Workspace) turns this into a view.create or
// view.update mutation, owning the id/sortKey/pin/open side effects.
export type ViewFormValue = {
	name: string;
	icon: string | null;
	scope: "personal" | "workspace";
	workspaceId: string | null;
	filter: FilterGroup;
	display: ViewDisplay;
};

const EMPTY_FILTER: FilterGroup = { op: "and", conditions: [] };
const DEFAULT_DISPLAY: ViewDisplay = {
	layout: "list",
	groupBy: "none",
	sort: { field: "sortKey", dir: "asc" },
	workspaceScope: { mode: "all" },
};

const LAYOUTS: { value: ViewLayout; label: string }[] = [
	{ value: "list", label: "List" },
	{ value: "board", label: "Board" },
	{ value: "table", label: "Table" },
	{ value: "calendar", label: "Calendar" },
];
const GROUP_BYS: { value: GroupBy; label: string }[] = [
	{ value: "none", label: "None" },
	{ value: "status", label: "Status" },
	{ value: "priority", label: "Priority" },
	{ value: "assignee", label: "Assignee" },
	{ value: "label", label: "Label" },
	{ value: "list", label: "List" },
	{ value: "due", label: "Due" },
];
const SORT_FIELDS: { value: string; label: string }[] = [
	{ value: "sortKey", label: "Manual" },
	{ value: "due", label: "Due date" },
	{ value: "priority", label: "Priority" },
	{ value: "title", label: "Title" },
];

// With `htmlFor` the caption is a real <label> bound to one control; without it
// (a composite like FilterBuilder) it is a plain section caption, not a label
// that would associate with no single control.
function Field({
	label,
	htmlFor,
	children,
}: {
	label: string;
	htmlFor?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1">
			{htmlFor ? (
				<label htmlFor={htmlFor} className="text-xs font-medium">
					{label}
				</label>
			) : (
				<span className="text-xs font-medium">{label}</span>
			)}
			{children}
		</div>
	);
}

export function ViewManager({
	open,
	onOpenChange,
	mode,
	initial,
	lists,
	folders,
	labels,
	members,
	workspaces,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mode: "create" | "edit";
	initial?: Partial<ViewFormValue>;
	lists: { id: string; title: string }[];
	folders: { id: string; name: string }[];
	labels: { id: string; name: string; color?: string }[];
	members: { id: string; name: string }[];
	workspaces: { id: string; name: string }[];
	onSubmit: (value: ViewFormValue) => void;
}): JSX.Element {
	const isDesktop = useIsDesktop();
	const baseId = useId();
	const firstWorkspace = workspaces[0]?.id ?? null;

	const [name, setName] = useState(initial?.name ?? "");
	const [filter, setFilter] = useState<FilterGroup>(
		initial?.filter ?? EMPTY_FILTER,
	);
	const [display, setDisplay] = useState<ViewDisplay>(
		initial?.display ?? DEFAULT_DISPLAY,
	);
	const [scope, setScope] = useState<"personal" | "workspace">(
		initial?.scope ?? "personal",
	);
	const [workspaceId, setWorkspaceId] = useState<string | null>(
		initial?.workspaceId ?? firstWorkspace,
	);

	const scopeWorkspaceId =
		display.workspaceScope.mode === "one" ? display.workspaceScope.id : "";

	// Scope is fixed at create time (view.update carries no scope/workspaceId), so
	// the personal<->workspace toggle only renders in create mode.
	const canSetScope = mode === "create";

	function setLayout(layout: ViewLayout) {
		setDisplay((d) => ({ ...d, layout }));
	}
	function setGroupBy(groupBy: GroupBy) {
		setDisplay((d) => ({ ...d, groupBy }));
	}
	function setSortField(field: string) {
		setDisplay((d) => ({ ...d, sort: { ...d.sort, field } }));
	}
	function setSortDir(dir: "asc" | "desc") {
		setDisplay((d) => ({ ...d, sort: { ...d.sort, dir } }));
	}
	function setScopeMode(mode: "all" | "one") {
		setDisplay((d) => {
			const next: WorkspaceScope =
				mode === "all"
					? { mode: "all" }
					: { mode: "one", id: firstWorkspace ?? "" };
			return { ...d, workspaceScope: next };
		});
	}
	function setScopeWorkspace(id: string) {
		setDisplay((d) => ({ ...d, workspaceScope: { mode: "one", id } }));
	}

	const trimmed = name.trim();
	const canSave =
		trimmed.length > 0 && (scope === "personal" || workspaceId != null);

	function submit() {
		if (!canSave) return;
		onSubmit({
			name: trimmed,
			icon: initial?.icon ?? null,
			scope,
			workspaceId: scope === "workspace" ? workspaceId : null,
			filter,
			display,
		});
	}

	const body = (
		<div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4 md:px-6">
			<Field label="Name" htmlFor={`${baseId}-name`}>
				<Input
					id={`${baseId}-name`}
					data-testid="view-name"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="View name"
				/>
			</Field>

			<Field label="Filter">
				<FilterBuilder
					value={filter}
					onChange={setFilter}
					lists={lists}
					folders={folders}
					labels={labels}
					members={members}
				/>
			</Field>

			<div className="grid grid-cols-2 gap-3">
				<Field label="Layout" htmlFor={`${baseId}-layout`}>
					<Select
						value={display.layout}
						onValueChange={(v) => setLayout(v as ViewLayout)}
					>
						<SelectTrigger id={`${baseId}-layout`} size="sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{LAYOUTS.map((o) => (
								<SelectItem key={o.value} value={o.value}>
									{o.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<Field label="Group by" htmlFor={`${baseId}-groupby`}>
					<Select
						value={display.groupBy}
						onValueChange={(v) => setGroupBy(v as GroupBy)}
					>
						<SelectTrigger id={`${baseId}-groupby`} size="sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{GROUP_BYS.map((o) => (
								<SelectItem key={o.value} value={o.value}>
									{o.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<Field label="Sort by" htmlFor={`${baseId}-sortfield`}>
					<Select value={display.sort.field} onValueChange={setSortField}>
						<SelectTrigger id={`${baseId}-sortfield`} size="sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{SORT_FIELDS.map((o) => (
								<SelectItem key={o.value} value={o.value}>
									{o.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<Field label="Direction" htmlFor={`${baseId}-sortdir`}>
					<Select
						value={display.sort.dir}
						onValueChange={(v) => setSortDir(v as "asc" | "desc")}
					>
						<SelectTrigger id={`${baseId}-sortdir`} size="sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="asc">Ascending</SelectItem>
							<SelectItem value="desc">Descending</SelectItem>
						</SelectContent>
					</Select>
				</Field>
				<Field label="Workspaces" htmlFor={`${baseId}-wsscope`}>
					<Select
						value={display.workspaceScope.mode === "one" ? "one" : "all"}
						onValueChange={(v) => setScopeMode(v === "one" ? "one" : "all")}
					>
						<SelectTrigger id={`${baseId}-wsscope`} size="sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All workspaces</SelectItem>
							<SelectItem value="one">One workspace</SelectItem>
						</SelectContent>
					</Select>
				</Field>
				{display.workspaceScope.mode === "one" && (
					<Field label="Workspace" htmlFor={`${baseId}-wsscope-one`}>
						<Select value={scopeWorkspaceId} onValueChange={setScopeWorkspace}>
							<SelectTrigger id={`${baseId}-wsscope-one`} size="sm">
								<SelectValue placeholder="Select..." />
							</SelectTrigger>
							<SelectContent>
								{workspaces.map((w) => (
									<SelectItem key={w.id} value={w.id}>
										{w.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
				)}
			</div>

			{canSetScope && (
				<div className="grid grid-cols-2 gap-3">
					<Field label="Visibility" htmlFor={`${baseId}-scope`}>
						<Select
							value={scope}
							onValueChange={(v) =>
								setScope(v === "workspace" ? "workspace" : "personal")
							}
						>
							<SelectTrigger id={`${baseId}-scope`} size="sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="personal">Personal</SelectItem>
								<SelectItem value="workspace">Workspace</SelectItem>
							</SelectContent>
						</Select>
					</Field>
					{scope === "workspace" && (
						<Field label="Shared in" htmlFor={`${baseId}-scope-ws`}>
							<Select
								value={workspaceId ?? ""}
								onValueChange={(v) => setWorkspaceId(v)}
							>
								<SelectTrigger id={`${baseId}-scope-ws`} size="sm">
									<SelectValue placeholder="Select..." />
								</SelectTrigger>
								<SelectContent>
									{workspaces.map((w) => (
										<SelectItem key={w.id} value={w.id}>
											{w.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
					)}
				</div>
			)}
		</div>
	);

	const title = mode === "create" ? "New view" : "Edit view";
	const footer = (
		<Button
			type="button"
			data-testid="view-save"
			disabled={!canSave}
			onClick={submit}
		>
			{mode === "create" ? "Create view" : "Save changes"}
		</Button>
	);

	if (isDesktop) {
		return (
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="max-h-[85dvh] max-w-lg gap-0 p-0">
					<DialogHeader className="p-4 pb-2 md:px-6">
						<DialogTitle>{title}</DialogTitle>
					</DialogHeader>
					{body}
					<DialogFooter className="border-t p-4 md:px-6">{footer}</DialogFooter>
				</DialogContent>
			</Dialog>
		);
	}

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="bottom" className="max-h-[90dvh] gap-0 pb-0">
				<SheetHeader>
					<SheetTitle>{title}</SheetTitle>
				</SheetHeader>
				{body}
				<div className="border-t p-4">{footer}</div>
			</SheetContent>
		</Sheet>
	);
}
