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
import { m } from "../../../paraglide/messages.js";
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

// Every option `value` below is persisted in view.display and stays a literal;
// only the labels are translated. Thunks, not resolved strings: these maps are
// module-level, so calling `m` here would freeze the import-time locale.
const LAYOUT_LABELS: Record<ViewLayout, () => string> = {
	list: m.view_layout_list,
	board: m.view_layout_board,
	table: m.view_layout_table,
	calendar: m.view_layout_calendar,
};
const GROUP_BY_LABELS: Record<GroupBy, () => string> = {
	none: m.view_groupby_none,
	status: m.field_status,
	priority: m.task_field_priority,
	assignee: m.field_assignee,
	label: m.field_label,
	list: m.field_list,
	due: m.task_field_due,
};
const SORT_FIELD_LABELS: Record<string, () => string> = {
	sortKey: m.view_sort_manual,
	due: m.view_sort_due_date,
	priority: m.task_field_priority,
	title: m.field_title,
};

const LAYOUTS = Object.keys(LAYOUT_LABELS) as ViewLayout[];
const GROUP_BYS = Object.keys(GROUP_BY_LABELS) as GroupBy[];
const SORT_FIELDS = Object.keys(SORT_FIELD_LABELS);

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
			<Field label={m.field_name()} htmlFor={`${baseId}-name`}>
				<Input
					id={`${baseId}-name`}
					data-testid="view-name"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder={m.view_name_placeholder()}
				/>
			</Field>

			<Field label={m.view_field_filter()}>
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
				<Field label={m.view_field_layout()} htmlFor={`${baseId}-layout`}>
					<Select
						value={display.layout}
						onValueChange={(v) => setLayout(v as ViewLayout)}
					>
						<SelectTrigger id={`${baseId}-layout`} size="sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{LAYOUTS.map((value) => (
								<SelectItem key={value} value={value}>
									{LAYOUT_LABELS[value]()}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<Field label={m.view_field_group_by()} htmlFor={`${baseId}-groupby`}>
					<Select
						value={display.groupBy}
						onValueChange={(v) => setGroupBy(v as GroupBy)}
					>
						<SelectTrigger id={`${baseId}-groupby`} size="sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{GROUP_BYS.map((value) => (
								<SelectItem key={value} value={value}>
									{GROUP_BY_LABELS[value]()}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<Field label={m.view_field_sort_by()} htmlFor={`${baseId}-sortfield`}>
					<Select value={display.sort.field} onValueChange={setSortField}>
						<SelectTrigger id={`${baseId}-sortfield`} size="sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{SORT_FIELDS.map((value) => (
								<SelectItem key={value} value={value}>
									{SORT_FIELD_LABELS[value]()}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<Field label={m.view_field_direction()} htmlFor={`${baseId}-sortdir`}>
					<Select
						value={display.sort.dir}
						onValueChange={(v) => setSortDir(v as "asc" | "desc")}
					>
						<SelectTrigger id={`${baseId}-sortdir`} size="sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="asc">{m.view_sort_asc()}</SelectItem>
							<SelectItem value="desc">{m.view_sort_desc()}</SelectItem>
						</SelectContent>
					</Select>
				</Field>
				<Field label={m.view_field_workspaces()} htmlFor={`${baseId}-wsscope`}>
					<Select
						value={display.workspaceScope.mode === "one" ? "one" : "all"}
						onValueChange={(v) => setScopeMode(v === "one" ? "one" : "all")}
					>
						<SelectTrigger id={`${baseId}-wsscope`} size="sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">
								{m.view_scope_all_workspaces()}
							</SelectItem>
							<SelectItem value="one">
								{m.view_scope_one_workspace()}
							</SelectItem>
						</SelectContent>
					</Select>
				</Field>
				{display.workspaceScope.mode === "one" && (
					<Field label={m.field_workspace()} htmlFor={`${baseId}-wsscope-one`}>
						<Select value={scopeWorkspaceId} onValueChange={setScopeWorkspace}>
							<SelectTrigger id={`${baseId}-wsscope-one`} size="sm">
								<SelectValue placeholder={m.select_placeholder()} />
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
					<Field label={m.view_field_visibility()} htmlFor={`${baseId}-scope`}>
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
								<SelectItem value="personal">
									{m.view_visibility_personal()}
								</SelectItem>
								<SelectItem value="workspace">
									{m.view_visibility_workspace()}
								</SelectItem>
							</SelectContent>
						</Select>
					</Field>
					{scope === "workspace" && (
						<Field
							label={m.view_field_shared_in()}
							htmlFor={`${baseId}-scope-ws`}
						>
							<Select
								value={workspaceId ?? ""}
								onValueChange={(v) => setWorkspaceId(v)}
							>
								<SelectTrigger id={`${baseId}-scope-ws`} size="sm">
									<SelectValue placeholder={m.select_placeholder()} />
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

	const title =
		mode === "create"
			? m.view_dialog_create_title()
			: m.view_dialog_edit_title();
	const footer = (
		<Button
			type="button"
			data-testid="view-save"
			disabled={!canSave}
			onClick={submit}
		>
			{mode === "create" ? m.view_submit_create() : m.view_submit_save()}
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
