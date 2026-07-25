import { Plus, Trash2 } from "lucide-react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { todayISO } from "@/lib/today";
import { cn } from "@/lib/utils";
import {
	type FilterCondition,
	type FilterField,
	type FilterGroup,
	type FilterNode,
	isGroup,
} from "../../../domain/view-filter.ts";
import { m } from "../../../paraglide/messages.js";
import { FIELD_METAS, metaFor, type ValueControl } from "./filter-options.ts";

type Option = { value: string; label: string };
type BuilderData = {
	lists: { id: string; title: string }[];
	folders: { id: string; name: string }[];
	labels: { id: string; name: string; color?: string }[];
	members: { id: string; name: string }[];
};

// "in" is the only multi-valued operator (emits string[]); all others emit a
// single scalar. Mirrors view-filter's asStringArray vs scalar handling.
function isMulti(operator: string): boolean {
	return operator === "in";
}

function optionsFor(control: ValueControl, data: BuilderData): Option[] {
	switch (control.kind) {
		case "select":
			return control.options;
		case "list":
			return data.lists.map((l) => ({ value: l.id, label: l.title }));
		case "folder":
			return data.folders.map((f) => ({ value: f.id, label: f.name }));
		case "label":
			return data.labels.map((l) => ({ value: l.id, label: l.name }));
		case "assignee":
			return [
				// "me" is the AST token view-filter resolves to the caller; only the
				// label is translated.
				{ value: "me", label: m.filter_assignee_me() },
				...data.members.map((member) => ({
					value: member.id,
					label: member.name,
				})),
			];
		default:
			return [];
	}
}

// A default value that keeps the emitted condition valid for taskMatchesFilter:
// bool -> true, date -> today's ISO date, multi -> [], priority -> number,
// data-backed single -> first option (assignee defaults to the "me" token).
function defaultValue(
	field: FilterField,
	operator: string,
	data: BuilderData,
): unknown {
	const control = metaFor(field).controlFor(operator);
	if (control.kind === "bool") return true;
	if (control.kind === "date") return todayISO();
	if (isMulti(operator)) return [];
	const first = optionsFor(control, data)[0]?.value ?? "";
	return field === "priority" ? Number(first || "0") : first;
}

function defaultCondition(
	field: FilterField,
	data: BuilderData,
): FilterCondition {
	const operator = metaFor(field).operators[0].value;
	return { field, operator, value: defaultValue(field, operator, data) };
}

// Control "shape" = kind + multiplicity. Switching operators keeps the current
// value when the shape is unchanged (eq->gte), resets it otherwise (is->before,
// eq->in) so the value never mismatches the control.
function controlShape(field: FilterField, operator: string): string {
	const control = metaFor(field).controlFor(operator);
	return `${control.kind}|${isMulti(operator) ? "multi" : "single"}`;
}

function MultiPicker({
	options,
	selected,
	onChange,
}: {
	options: Option[];
	selected: string[];
	onChange: (next: string[]) => void;
}) {
	const set = new Set(selected);
	const toggle = (value: string) => {
		const next = new Set(set);
		if (next.has(value)) next.delete(value);
		else next.add(value);
		onChange([...next]);
	};
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					aria-label={m.filter_value_label()}
					data-testid="value-control"
					className="min-w-32 justify-between"
				>
					{selected.length === 0
						? m.filter_multi_any()
						: m.filter_multi_selected({ count: selected.length })}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-56">
				<div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
					{options.length === 0 && (
						<span className="px-1.5 py-1 text-xs text-muted-foreground">
							{m.filter_no_options()}
						</span>
					)}
					{options.map((o) => (
						<button
							key={o.value}
							type="button"
							aria-pressed={set.has(o.value)}
							onClick={() => toggle(o.value)}
							className="flex items-center gap-2 rounded-md px-1.5 py-1 text-start text-sm hover:bg-muted"
						>
							<Checkbox
								checked={set.has(o.value)}
								aria-hidden
								tabIndex={-1}
								className="pointer-events-none"
							/>
							<span className="min-w-0 flex-1 truncate">{o.label}</span>
						</button>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}

function ConditionRow({
	condition,
	onChange,
	onRemove,
	data,
}: {
	condition: FilterCondition;
	onChange: (next: FilterCondition) => void;
	onRemove: () => void;
	data: BuilderData;
}) {
	const meta = metaFor(condition.field);
	const control = meta.controlFor(condition.operator);

	const changeField = (value: string) => {
		const field = value as FilterField;
		onChange(defaultCondition(field, data));
	};
	const changeOperator = (operator: string) => {
		const keep =
			controlShape(condition.field, condition.operator) ===
			controlShape(condition.field, operator);
		onChange({
			...condition,
			operator,
			value: keep
				? condition.value
				: defaultValue(condition.field, operator, data),
		});
	};
	const setValue = (value: unknown) => onChange({ ...condition, value });

	function renderValue() {
		if (control.kind === "bool") {
			return (
				<Select
					value={condition.value === true ? "true" : "false"}
					onValueChange={(v) => setValue(v === "true")}
				>
					<SelectTrigger
						size="sm"
						aria-label={m.filter_value_label()}
						data-testid="value-control"
						className="min-w-28"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="true">{m.status_done()}</SelectItem>
						<SelectItem value="false">{m.status_not_done()}</SelectItem>
					</SelectContent>
				</Select>
			);
		}
		if (control.kind === "date") {
			return (
				<Input
					type="date"
					aria-label={m.filter_value_label()}
					data-testid="value-control"
					className="h-7 w-auto"
					value={typeof condition.value === "string" ? condition.value : ""}
					onChange={(e) => setValue(e.target.value || todayISO())}
				/>
			);
		}
		const opts = optionsFor(control, data);
		if (isMulti(condition.operator)) {
			return (
				<MultiPicker
					options={opts}
					selected={Array.isArray(condition.value) ? condition.value : []}
					onChange={setValue}
				/>
			);
		}
		const current =
			condition.field === "priority"
				? String(condition.value ?? "0")
				: typeof condition.value === "string"
					? condition.value
					: "";
		return (
			<Select
				value={current}
				onValueChange={(v) =>
					setValue(condition.field === "priority" ? Number(v) : v)
				}
			>
				<SelectTrigger
					size="sm"
					aria-label={m.filter_value_label()}
					data-testid="value-control"
					className="min-w-32"
				>
					<SelectValue placeholder={m.select_placeholder()} />
				</SelectTrigger>
				<SelectContent>
					{opts.map((o) => (
						<SelectItem key={o.value} value={o.value}>
							{o.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		);
	}

	return (
		<fieldset
			aria-label={m.filter_condition_label()}
			className="flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0"
		>
			<Select value={condition.field} onValueChange={changeField}>
				<SelectTrigger
					size="sm"
					aria-label={m.filter_field_label()}
					data-testid="field-select"
					className="min-w-28"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{FIELD_METAS.map((meta) => (
						<SelectItem key={meta.field} value={meta.field}>
							{meta.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Select value={condition.operator} onValueChange={changeOperator}>
				<SelectTrigger
					size="sm"
					aria-label={m.filter_operator_label()}
					data-testid="operator-select"
					className="min-w-24"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{meta.operators.map((o) => (
						<SelectItem key={o.value} value={o.value}>
							{o.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{renderValue()}
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={m.filter_remove_condition()}
				data-testid="remove"
				className="ms-auto"
				onClick={onRemove}
			>
				<Trash2 />
			</Button>
		</fieldset>
	);
}

function GroupCard({
	group,
	onChange,
	onRemove,
	data,
	depth,
}: {
	group: FilterGroup;
	onChange: (next: FilterGroup) => void;
	onRemove?: () => void;
	data: BuilderData;
	depth: number;
}) {
	const setNode = (index: number, node: FilterNode) =>
		onChange({
			...group,
			conditions: group.conditions.map((c, j) => (j === index ? node : c)),
		});
	const removeAt = (index: number) =>
		onChange({
			...group,
			conditions: group.conditions.filter((_, j) => j !== index),
		});
	const addCondition = () =>
		onChange({
			...group,
			conditions: [...group.conditions, defaultCondition("done", data)],
		});
	const addGroup = () =>
		onChange({
			...group,
			conditions: [...group.conditions, { op: "and", conditions: [] }],
		});

	return (
		<fieldset
			aria-label={
				depth === 0
					? m.filter_conditions_label()
					: m.filter_nested_group_label()
			}
			className={cn(
				"flex min-w-0 flex-col gap-2 rounded-lg border p-2.5",
				depth > 0 && "bg-muted/30",
			)}
		>
			<div className="flex items-center gap-2">
				<span className="text-xs font-medium text-muted-foreground">
					{depth === 0 ? m.filter_heading_filters() : m.filter_heading_group()}
				</span>
				<span className="text-xs text-muted-foreground">
					{m.filter_match()}
				</span>
				<Select
					value={group.op}
					onValueChange={(v) =>
						onChange({ ...group, op: v === "or" ? "or" : "and" })
					}
				>
					<SelectTrigger
						size="sm"
						aria-label={m.filter_combine_label()}
						data-testid="group-op"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="and">{m.filter_combine_all()}</SelectItem>
						<SelectItem value="or">{m.filter_combine_any()}</SelectItem>
					</SelectContent>
				</Select>
				{onRemove && (
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={m.filter_remove_group()}
						data-testid="remove"
						className="ms-auto"
						onClick={onRemove}
					>
						<Trash2 />
					</Button>
				)}
			</div>

			<div className="flex flex-col gap-2">
				{group.conditions.length === 0 && (
					<p className="text-xs text-muted-foreground">
						{m.filter_no_conditions()}
					</p>
				)}
				{group.conditions.map((node, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: filter nodes have no stable id; the AST is positional
					<div key={i} className="flex flex-col gap-1">
						{i > 0 && (
							<span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
								{group.op === "or" ? m.filter_join_or() : m.filter_join_and()}
							</span>
						)}
						{isGroup(node) ? (
							<GroupCard
								group={node}
								onChange={(g) => setNode(i, g)}
								onRemove={() => removeAt(i)}
								data={data}
								depth={depth + 1}
							/>
						) : (
							<ConditionRow
								condition={node}
								onChange={(c) => setNode(i, c)}
								onRemove={() => removeAt(i)}
								data={data}
							/>
						)}
					</div>
				))}
			</div>

			<div className="flex flex-wrap gap-1.5">
				<Button
					variant="outline"
					size="sm"
					data-testid="add-condition"
					onClick={addCondition}
				>
					<Plus /> {m.filter_add_condition()}
				</Button>
				<Button
					variant="outline"
					size="sm"
					data-testid="add-group"
					onClick={addGroup}
				>
					<Plus /> {m.filter_add_group()}
				</Button>
			</div>
		</fieldset>
	);
}

export function FilterBuilder(props: {
	value: FilterGroup;
	onChange: (next: FilterGroup) => void;
	lists: { id: string; title: string }[];
	folders: { id: string; name: string }[];
	labels: { id: string; name: string; color?: string }[];
	members: { id: string; name: string }[];
}): React.JSX.Element {
	const data: BuilderData = {
		lists: props.lists,
		folders: props.folders,
		labels: props.labels,
		members: props.members,
	};
	return (
		<GroupCard
			group={props.value}
			onChange={props.onChange}
			data={data}
			depth={0}
		/>
	);
}
