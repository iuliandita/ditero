import type { ListKind } from "../../../domain/icon-map.ts";
import type { FilterField } from "../../../domain/view-filter.ts";

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

// Order = the object-literal order (matches the listKindEnum). Kept as a literal
// rather than importing the Drizzle enum so no server runtime reaches the client.
const KIND_LABELS: Record<ListKind, string> = {
	tasks: "Tasks",
	shopping: "Shopping",
	checklist: "Checklist",
	project: "Project",
	habits: "Habits",
};

const KIND_OPTIONS: OperatorOption[] = (
	Object.keys(KIND_LABELS) as ListKind[]
).map((k) => ({ value: k, label: KIND_LABELS[k] }));

const PRIORITY_OPTIONS: OperatorOption[] = [
	{ value: "0", label: "None" },
	{ value: "1", label: "Low" },
	{ value: "2", label: "Medium" },
	{ value: "3", label: "High" },
];

const DUE_LITERAL_OPTIONS: OperatorOption[] = [
	{ value: "today", label: "Today" },
	{ value: "overdue", label: "Overdue" },
	{ value: "next7", label: "Next 7 days" },
	{ value: "none", label: "No due date" },
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

export const FIELD_METAS: FieldMeta[] = [
	{
		field: "done",
		label: "Status",
		operators: [{ value: "is", label: "is" }],
		controlFor: () => ({ kind: "bool" }),
	},
	{
		field: "due",
		label: "Due",
		operators: [
			{ value: "is", label: "is" },
			{ value: "before", label: "before" },
			{ value: "after", label: "after" },
		],
		// due is the one field that switches control by operator: the "is" literal
		// picker vs an ISO date bound for before/after.
		controlFor: (op) => (op === "is" ? SELECT_DUE : { kind: "date" }),
	},
	{
		field: "priority",
		label: "Priority",
		operators: [
			{ value: "eq", label: "is" },
			{ value: "gte", label: "is at least" },
			{ value: "lte", label: "is at most" },
		],
		// Options are strings; the builder coerces to number when emitting.
		controlFor: () => SELECT_PRIORITY,
	},
	{
		field: "kind",
		label: "List kind",
		operators: [
			{ value: "eq", label: "is" },
			{ value: "in", label: "is any of" },
		],
		// "in" renders the same option set as a multi-select (emits string[]).
		controlFor: () => SELECT_KIND,
	},
	{
		field: "list",
		label: "List",
		operators: [
			{ value: "eq", label: "is" },
			{ value: "in", label: "is any of" },
		],
		controlFor: () => ({ kind: "list" }),
	},
	{
		field: "folder",
		label: "Folder",
		operators: [
			{ value: "eq", label: "is" },
			{ value: "in", label: "is any of" },
		],
		controlFor: () => ({ kind: "folder" }),
	},
	{
		field: "label",
		label: "Label",
		operators: [
			{ value: "includes", label: "includes" },
			{ value: "excludes", label: "excludes" },
		],
		controlFor: () => ({ kind: "label" }),
	},
	{
		field: "assignee",
		label: "Assignee",
		operators: [
			{ value: "includes", label: "includes" },
			{ value: "excludes", label: "excludes" },
		],
		controlFor: () => ({ kind: "assignee" }),
	},
];

const META_BY_FIELD = new Map(FIELD_METAS.map((m) => [m.field, m]));

export function metaFor(field: FilterField): FieldMeta {
	const meta = META_BY_FIELD.get(field);
	if (!meta) throw new Error(`filter-options: no meta for field '${field}'`);
	return meta;
}
