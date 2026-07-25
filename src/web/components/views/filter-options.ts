import type { ListKind } from "../../../domain/icon-map.ts";
import type { FilterField } from "../../../domain/view-filter.ts";
import { m } from "../../../paraglide/messages.js";
import { priorityLabel } from "../../lib/task-display.ts";

// Declarative metadata driving FilterBuilder. Each field maps to its allowed
// operators and, per operator, the value control the row renders. Kept pure and
// data-free so the recursive builder stays small and this file is unit-testable.
// The emitted conditions must satisfy view-filter's matchCondition (operator +
// value shape per field); see that module for the source-of-truth semantics.
export type ValueControl =
	| { kind: "bool" }
	| { kind: "select"; options: { value: string; label: string }[] }
	| { kind: "date" }
	| { kind: "list" }
	| { kind: "folder" }
	| { kind: "label" }
	| { kind: "assignee" };

export type OperatorOption = { value: string; label: string };

export type FieldMeta = {
	field: FilterField;
	label: string;
	operators: OperatorOption[];
	controlFor: (operator: string) => ValueControl;
};

// Every `value` below is part of the persisted filter AST (view.filter) and is
// never translated; only `label` is. `label` is a getter throughout: these are
// module-level, so resolving a message eagerly would freeze the import-time
// locale.
// Order = the object-literal order (matches the listKindEnum). Kept as a literal
// rather than importing the Drizzle enum so no server runtime reaches the client.
const KIND_LABELS: Record<ListKind, () => string> = {
	tasks: m.list_kind_tasks,
	shopping: m.list_kind_shopping,
	checklist: m.list_kind_checklist,
	project: m.list_kind_project,
	habits: m.list_kind_habits,
};

const KIND_OPTIONS: OperatorOption[] = (
	Object.keys(KIND_LABELS) as ListKind[]
).map((k) => ({
	value: k,
	get label() {
		return KIND_LABELS[k]();
	},
}));

const PRIORITY_OPTIONS: OperatorOption[] = [0, 1, 2, 3].map((p) => ({
	value: String(p),
	get label() {
		return priorityLabel(p);
	},
}));

const DUE_LITERAL_OPTIONS: OperatorOption[] = [
	{
		value: "today",
		get label() {
			return m.due_today();
		},
	},
	{
		value: "overdue",
		get label() {
			return m.due_overdue();
		},
	},
	{
		value: "next7",
		get label() {
			return m.due_next7();
		},
	},
	{
		value: "none",
		get label() {
			return m.filter_due_none();
		},
	},
];

const SELECT_KIND: ValueControl = { kind: "select", options: KIND_OPTIONS };
const SELECT_PRIORITY: ValueControl = {
	kind: "select",
	options: PRIORITY_OPTIONS,
};
const SELECT_DUE: ValueControl = {
	kind: "select",
	options: DUE_LITERAL_OPTIONS,
};

// Operator identifiers are AST values; each maps to exactly one display label
// across every field ("eq" and due's "is" both read as "is").
const OPERATOR_LABELS: Record<string, () => string> = {
	is: m.filter_op_is,
	eq: m.filter_op_is,
	before: m.filter_op_before,
	after: m.filter_op_after,
	gte: m.filter_op_is_at_least,
	lte: m.filter_op_is_at_most,
	in: m.filter_op_is_any_of,
	includes: m.filter_op_includes,
	excludes: m.filter_op_excludes,
};

function op(value: string): OperatorOption {
	return {
		value,
		get label() {
			return OPERATOR_LABELS[value]();
		},
	};
}

export const FIELD_METAS: FieldMeta[] = [
	{
		field: "done",
		get label() {
			return m.field_status();
		},
		operators: [op("is")],
		controlFor: () => ({ kind: "bool" }),
	},
	{
		field: "due",
		get label() {
			return m.task_field_due();
		},
		operators: [op("is"), op("before"), op("after")],
		// due is the one field that switches control by operator: the "is" literal
		// picker vs an ISO date bound for before/after.
		controlFor: (operator) =>
			operator === "is" ? SELECT_DUE : { kind: "date" },
	},
	{
		field: "priority",
		get label() {
			return m.task_field_priority();
		},
		operators: [op("eq"), op("gte"), op("lte")],
		// Options are strings; the builder coerces to number when emitting.
		controlFor: () => SELECT_PRIORITY,
	},
	{
		field: "kind",
		get label() {
			return m.field_list_kind();
		},
		operators: [op("eq"), op("in")],
		// "in" renders the same option set as a multi-select (emits string[]).
		controlFor: () => SELECT_KIND,
	},
	{
		field: "list",
		get label() {
			return m.field_list();
		},
		operators: [op("eq"), op("in")],
		controlFor: () => ({ kind: "list" }),
	},
	{
		field: "folder",
		get label() {
			return m.field_folder();
		},
		operators: [op("eq"), op("in")],
		controlFor: () => ({ kind: "folder" }),
	},
	{
		field: "label",
		get label() {
			return m.field_label();
		},
		operators: [op("includes"), op("excludes")],
		controlFor: () => ({ kind: "label" }),
	},
	{
		field: "assignee",
		get label() {
			return m.field_assignee();
		},
		operators: [op("includes"), op("excludes")],
		controlFor: () => ({ kind: "assignee" }),
	},
];

const META_BY_FIELD = new Map(FIELD_METAS.map((meta) => [meta.field, meta]));

export function metaFor(field: FilterField): FieldMeta {
	const meta = META_BY_FIELD.get(field);
	if (!meta) throw new Error(`filter-options: no meta for field '${field}'`);
	return meta;
}
