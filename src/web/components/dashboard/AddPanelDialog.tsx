import { Flame, Hash, ListChecks, Timer } from "lucide-react";
import { type JSX, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

type PanelType = Panel["type"];
const MAX_STREAK_HABITS = 10;

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
	{
		value: "streak",
		label: "Streak",
		hint: "Current streaks for picked habits",
		icon: Flame,
	},
	{
		value: "focus",
		label: "Focus",
		hint: "Your focus sessions and minutes",
		icon: Timer,
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

// Add + edit dialog for all panel types: step 1 type picker (add only), step 2
// per-type config (source for tasks/counter, habit multi-pick for streak,
// range for focus) + size/title. Emits a complete schema-valid Panel; the
// caller appends or replaces via dashboard.update.
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
	habitTasks,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mode: "add" | "edit";
	// MAX_PANELS reached: adding would only fail server-side, so block save.
	atCap: boolean;
	initial?: Panel;
	views: { id: string; name: string }[];
	lists: { id: string; title: string }[];
	folders: { id: string; name: string }[];
	labels: { id: string; name: string; color?: string }[];
	members: { id: string; name: string }[];
	workspaces: { id: string; name: string }[];
	// Synced habit-kind tasks (tasks on lists of kind "habits").
	habitTasks: { id: string; title: string }[];
	onSubmit: (panel: Panel) => void;
}): JSX.Element {
	const isDesktop = useIsDesktop();
	const baseId = useId();
	const firstWorkspace = workspaces[0]?.id ?? "";

	const [type, setType] = useState<PanelType | null>(initial?.type ?? null);
	const initialSource =
		initial?.type === "tasks" || initial?.type === "counter"
			? initial.source
			: undefined;
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
	const [habitIds, setHabitIds] = useState<string[]>(
		initial?.type === "streak" ? initial.habitIds : [],
	);
	const [range, setRange] = useState<"today" | "week">(
		initial?.type === "focus" ? initial.range : "today",
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
	// Ids carried in from an edited panel that no longer resolve to a synced
	// habit task (deleted/unshared). Shown as explicit removable rows (StreakPanel
	// philosophy: never silent); they count toward the cap until dropped, and a
	// pick that holds ONLY missing ids does not validate.
	const habitTaskIds = new Set(habitTasks.map((h) => h.id));
	const missingHabitIds = habitIds.filter((id) => !habitTaskIds.has(id));
	const configValid =
		type === "tasks" || type === "counter"
			? sourceValid && limitValid
			: type === "streak"
				? habitIds.some((id) => habitTaskIds.has(id)) &&
					habitIds.length <= MAX_STREAK_HABITS
				: true; // focus: range always set
	const canSave = type !== null && configValid && !(mode === "add" && atCap);

	function toggleHabit(id: string, checked: boolean) {
		setHabitIds((ids) =>
			checked
				? ids.includes(id)
					? ids
					: [...ids, id]
				: ids.filter((h) => h !== id),
		);
	}

	function submit() {
		if (!canSave || type === null) return;
		const trimmed = title.trim();
		const base = {
			id: initial?.id ?? crypto.randomUUID(),
			size,
			...(trimmed ? { title: trimmed } : {}),
		};
		if (type === "streak") {
			onSubmit({ ...base, type: "streak", habitIds });
			return;
		}
		if (type === "focus") {
			onSubmit({ ...base, type: "focus", range });
			return;
		}
		const source: PanelSource =
			sourceMode === "view"
				? { kind: "view", viewId }
				: { kind: "inline", filter, sort, workspaceScope: scope };
		onSubmit(
			type === "tasks"
				? {
						...base,
						type: "tasks",
						source,
						...(limitNum !== null ? { limit: limitNum } : {}),
					}
				: { ...base, type: "counter", source },
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

	const sourceStep = (
		<>
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
		</>
	);

	// Multi-pick 1..10 habit-kind tasks; unchecked boxes disable at the cap so
	// the emitted array always passes the server-side 1..10 bound.
	const atHabitCap = habitIds.length >= MAX_STREAK_HABITS;
	const streakStep = (
		<fieldset className="flex flex-col gap-1">
			<legend className="mb-1 text-xs font-medium">
				Habits (pick 1-{MAX_STREAK_HABITS})
			</legend>
			{missingHabitIds.map((id) => {
				const inputId = `${baseId}-habit-${id}`;
				return (
					<div
						key={id}
						className="flex min-h-9 items-center gap-2.5 rounded px-1 text-sm"
					>
						<Checkbox
							id={inputId}
							data-testid="panel-habit-missing"
							checked
							onCheckedChange={(v) => {
								if (v !== true) toggleHabit(id, false);
							}}
						/>
						<label
							htmlFor={inputId}
							className="min-w-0 flex-1 truncate text-muted-foreground"
						>
							Missing habit (deleted or not shared with you)
						</label>
					</div>
				);
			})}
			{habitTasks.length === 0 && missingHabitIds.length === 0 ? (
				<p
					data-testid="panel-no-habits"
					className="text-sm text-muted-foreground"
				>
					No habits yet. Add tasks to a habits list first.
				</p>
			) : (
				habitTasks.map((h) => {
					const checked = habitIds.includes(h.id);
					const inputId = `${baseId}-habit-${h.id}`;
					return (
						<div
							key={h.id}
							className="flex min-h-9 items-center gap-2.5 rounded px-1 text-sm hover:bg-muted/40"
						>
							<Checkbox
								id={inputId}
								data-testid="panel-habit-pick"
								checked={checked}
								disabled={!checked && atHabitCap}
								onCheckedChange={(v) => toggleHabit(h.id, v === true)}
							/>
							<label htmlFor={inputId} className="min-w-0 flex-1 truncate">
								{h.title}
							</label>
						</div>
					);
				})
			)}
		</fieldset>
	);

	const focusStep = (
		<fieldset className="flex flex-col gap-1">
			<legend className="mb-1 text-xs font-medium">Range</legend>
			{(["today", "week"] as const).map((r) => (
				<label
					key={r}
					className="flex min-h-9 items-center gap-2.5 rounded px-1 text-sm hover:bg-muted/40"
				>
					<input
						type="radio"
						name={`${baseId}-range`}
						data-testid={`panel-range-${r}`}
						value={r}
						checked={range === r}
						onChange={() => setRange(r)}
						className="size-4 accent-primary"
					/>
					{r === "today" ? "Today" : "Last 7 days"}
				</label>
			))}
		</fieldset>
	);

	const configStep = (
		<div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4 md:px-6">
			{(type === "tasks" || type === "counter") && sourceStep}
			{type === "streak" && streakStep}
			{type === "focus" && focusStep}

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
