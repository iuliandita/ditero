import { Hash, ListChecks } from "lucide-react";
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
import {
	PANEL_SPANS,
	type Panel,
	type PanelSize,
	type PanelSource,
} from "../../../domain/dashboard.ts";
import type {
	FilterGroup,
	WorkspaceScope,
} from "../../../domain/view-filter.ts";
import { FilterBuilder } from "../views/FilterBuilder.tsx";
import { SIZE_LABEL } from "./PanelFrame.tsx";

// Streak/focus config steps are Task 8; until then the type picker offers only
// the source-driven panels (hidden, not disabled, per the Task 7 decision).
type PanelType = "tasks" | "counter";
type EditablePanel = Extract<Panel, { type: PanelType }>;

const TYPE_OPTIONS: {
	value: PanelType;
	label: string;
	hint: string;
	icon: typeof ListChecks;
}[] = [
	{
		value: "tasks",
		label: "Tasks",
		hint: "A live list of matching tasks",
		icon: ListChecks,
	},
	{
		value: "counter",
		label: "Counter",
		hint: "A single count of matching tasks",
		icon: Hash,
	},
];

const SIZE_OPTIONS = (Object.keys(PANEL_SPANS) as PanelSize[]).map((v) => ({
	value: v,
	label: SIZE_LABEL[v],
}));

const SORT_FIELDS: { value: string; label: string }[] = [
	{ value: "sortKey", label: "Manual" },
	{ value: "due", label: "Due date" },
	{ value: "priority", label: "Priority" },
	{ value: "title", label: "Title" },
];

const EMPTY_FILTER: FilterGroup = { op: "and", conditions: [] };

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

// Add + edit dialog for tasks/counter panels: step 1 type picker (add only),
// step 2 source (saved view OR inline filter+sort+scope) + size/title/limit.
// Emits a complete Panel; the caller appends or replaces via dashboard.update.
export function AddPanelDialog({
	open,
	onOpenChange,
	mode,
	atCap,
	initial,
	views,
	lists,
	folders,
	labels,
	members,
	workspaces,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mode: "add" | "edit";
	// MAX_PANELS reached: adding would only fail server-side, so block save.
	atCap: boolean;
	initial?: EditablePanel;
	views: { id: string; name: string }[];
	lists: { id: string; title: string }[];
	folders: { id: string; name: string }[];
	labels: { id: string; name: string; color?: string }[];
	members: { id: string; name: string }[];
	workspaces: { id: string; name: string }[];
	onSubmit: (panel: Panel) => void;
}): JSX.Element {
	const isDesktop = useIsDesktop();
	const baseId = useId();
	const firstWorkspace = workspaces[0]?.id ?? "";

	const [type, setType] = useState<PanelType | null>(initial?.type ?? null);
	const initialSource = initial?.source;
	const [sourceMode, setSourceMode] = useState<"view" | "inline">(
		initialSource?.kind === "inline" ? "inline" : "view",
	);
	// A dangling ref ("Replace view") prefills as empty so save forces a real pick.
	const [viewId, setViewId] = useState(() =>
		initialSource?.kind === "view" &&
		views.some((v) => v.id === initialSource.viewId)
			? initialSource.viewId
			: "",
	);
	const [filter, setFilter] = useState<FilterGroup>(
		initialSource?.kind === "inline" ? initialSource.filter : EMPTY_FILTER,
	);
	const [sort, setSort] = useState<{ field: string; dir: "asc" | "desc" }>(
		initialSource?.kind === "inline"
			? initialSource.sort
			: { field: "sortKey", dir: "asc" },
	);
	const [scope, setScope] = useState<WorkspaceScope>(
		initialSource?.kind === "inline"
			? initialSource.workspaceScope
			: { mode: "all" },
	);
	const [size, setSize] = useState<PanelSize>(initial?.size ?? "m");
	const [title, setTitle] = useState(initial?.title ?? "");
	const [limit, setLimit] = useState(
		initial?.type === "tasks" && initial.limit != null
			? String(initial.limit)
			: "",
	);

	const scopeWorkspaceId = scope.mode === "one" ? scope.id : "";
	const limitNum = limit.trim() === "" ? null : Number(limit);
	const limitValid =
		limitNum === null ||
		(Number.isInteger(limitNum) && limitNum >= 1 && limitNum <= 50);
	const sourceValid =
		sourceMode === "view"
			? viewId !== ""
			: scope.mode !== "one" || scope.id !== "";
	const canSave =
		type !== null && sourceValid && limitValid && !(mode === "add" && atCap);

	function submit() {
		if (!canSave || type === null) return;
		const source: PanelSource =
			sourceMode === "view"
				? { kind: "view", viewId }
				: { kind: "inline", filter, sort, workspaceScope: scope };
		const trimmed = title.trim();
		const base = {
			id: initial?.id ?? crypto.randomUUID(),
			source,
			size,
			...(trimmed ? { title: trimmed } : {}),
		};
		onSubmit(
			type === "tasks"
				? {
						...base,
						type: "tasks",
						...(limitNum !== null ? { limit: limitNum } : {}),
					}
				: { ...base, type: "counter" },
		);
	}

	const typeStep = (
		<div className="flex flex-col gap-2 px-4 pb-4 md:px-6">
			<p className="text-xs font-medium">Panel type</p>
			{TYPE_OPTIONS.map((o) => (
				<button
					key={o.value}
					type="button"
					data-testid={`panel-type-${o.value}`}
					onClick={() => setType(o.value)}
					className="flex items-center gap-3 rounded-lg border p-3 text-start hover:bg-muted/40"
				>
					<o.icon
						aria-hidden
						className="size-5 shrink-0 text-muted-foreground"
					/>
					<span className="flex min-w-0 flex-col">
						<span className="text-sm font-medium">{o.label}</span>
						<span className="text-xs text-muted-foreground">{o.hint}</span>
					</span>
				</button>
			))}
		</div>
	);

	const configStep = (
		<div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4 md:px-6">
			<Field label="Source" htmlFor={`${baseId}-source`}>
				<Select
					value={sourceMode}
					onValueChange={(v) =>
						setSourceMode(v === "inline" ? "inline" : "view")
					}
				>
					<SelectTrigger
						id={`${baseId}-source`}
						size="sm"
						data-testid="panel-source-mode"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="view">Saved view</SelectItem>
						<SelectItem value="inline">Custom filter</SelectItem>
					</SelectContent>
				</Select>
			</Field>

			{sourceMode === "view" ? (
				<Field label="View" htmlFor={`${baseId}-view`}>
					<Select value={viewId} onValueChange={setViewId}>
						<SelectTrigger
							id={`${baseId}-view`}
							size="sm"
							data-testid="panel-view-pick"
						>
							<SelectValue placeholder="Select a view..." />
						</SelectTrigger>
						<SelectContent>
							{views.length === 0 && (
								<span className="block px-2 py-1.5 text-xs text-muted-foreground">
									No saved views yet.
								</span>
							)}
							{views.map((v) => (
								<SelectItem key={v.id} value={v.id}>
									{v.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
			) : (
				<>
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
						<Field label="Sort by" htmlFor={`${baseId}-sortfield`}>
							<Select
								value={sort.field}
								onValueChange={(field) => setSort((s) => ({ ...s, field }))}
							>
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
								value={sort.dir}
								onValueChange={(v) =>
									setSort((s) => ({ ...s, dir: v === "desc" ? "desc" : "asc" }))
								}
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
								value={scope.mode === "one" ? "one" : "all"}
								onValueChange={(v) =>
									setScope(
										v === "one"
											? { mode: "one", id: firstWorkspace }
											: { mode: "all" },
									)
								}
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
						{scope.mode === "one" && (
							<Field label="Workspace" htmlFor={`${baseId}-wsscope-one`}>
								<Select
									value={scopeWorkspaceId}
									onValueChange={(id) => setScope({ mode: "one", id })}
								>
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
				</>
			)}

			<div className="grid grid-cols-2 gap-3">
				<Field label="Size" htmlFor={`${baseId}-size`}>
					<Select value={size} onValueChange={(v) => setSize(v as PanelSize)}>
						<SelectTrigger
							id={`${baseId}-size`}
							size="sm"
							data-testid="panel-size"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{SIZE_OPTIONS.map((o) => (
								<SelectItem key={o.value} value={o.value}>
									{o.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				{type === "tasks" && (
					<Field label="Limit (1-50)" htmlFor={`${baseId}-limit`}>
						<Input
							id={`${baseId}-limit`}
							data-testid="panel-limit"
							type="number"
							min={1}
							max={50}
							placeholder="10"
							aria-invalid={!limitValid}
							value={limit}
							onChange={(e) => setLimit(e.target.value)}
						/>
					</Field>
				)}
			</div>

			<Field label="Title (optional)" htmlFor={`${baseId}-title`}>
				<Input
					id={`${baseId}-title`}
					data-testid="panel-title"
					maxLength={120}
					placeholder="Panel title"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
				/>
			</Field>

			<p className="text-xs text-muted-foreground">
				On phones, panels stack in dashboard order.
			</p>
		</div>
	);

	const showTypeStep = type === null;
	const body = showTypeStep ? typeStep : configStep;
	const dialogTitle = mode === "add" ? "Add panel" : "Edit panel";
	const footer = !showTypeStep && (
		<div className="flex w-full items-center gap-2">
			{mode === "add" && (
				<Button
					type="button"
					variant="ghost"
					data-testid="panel-back"
					onClick={() => setType(null)}
				>
					Back
				</Button>
			)}
			<Button
				type="button"
				data-testid="panel-save"
				disabled={!canSave}
				className="ms-auto"
				onClick={submit}
			>
				{mode === "add" ? "Add panel" : "Save panel"}
			</Button>
		</div>
	);

	if (isDesktop) {
		return (
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="max-h-[85dvh] max-w-lg gap-0 p-0">
					<DialogHeader className="p-4 pb-2 md:px-6">
						<DialogTitle>{dialogTitle}</DialogTitle>
					</DialogHeader>
					{body}
					{footer && (
						<DialogFooter className="border-t p-4 md:px-6">
							{footer}
						</DialogFooter>
					)}
				</DialogContent>
			</Dialog>
		);
	}

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="bottom" className="max-h-[90dvh] gap-0 pb-0">
				<SheetHeader>
					<SheetTitle>{dialogTitle}</SheetTitle>
				</SheetHeader>
				{body}
				{footer && <div className="border-t p-4">{footer}</div>}
			</SheetContent>
		</Sheet>
	);
}
