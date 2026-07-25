// Module-level constants that hold translated strings must resolve `m` at read
// time. An eager `m.x()` at module scope resolves once at import and freezes
// that locale for the process lifetime -- a regression this project has shipped
// three times (SIZE_LABEL twice, once via a re-export into another constant).
//
// The imports below are evaluated under the base locale before any test runs;
// each probe then reads the same constant after the ambient locale flips. A
// frozen constant keeps returning English and the probe fails.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import type { Locale } from "../domain/locale.ts";
import { m } from "../paraglide/messages.js";
import * as runtime from "../paraglide/runtime.js";
import { SIZE_LABEL } from "./components/dashboard/PanelFrame.tsx";
import { reasonLabel } from "./components/karma/karma-format.ts";
import { ROLE_LABELS } from "./components/people/role-labels.ts";
import {
	metaFor,
	SORT_FIELD_LABELS,
} from "./components/views/filter-options.ts";
import { formatBinding } from "./keyboard/binding-label.ts";
import { categoryLabel } from "./keyboard/category-label.ts";
import { COMMANDS } from "./keyboard/commands.ts";
import {
	channelErrorMessage,
	channelFieldLabel,
	channelLabel,
	channelSaveErrorMessage,
	channelWarningMessage,
} from "./lib/channel-messages.ts";
import {
	PRIORITIES,
	priorityLabel,
	priorityLabelShort,
} from "./lib/task-display.ts";
import { BUILTIN_VIEWS } from "./views/builtins.ts";
import { groupTasks } from "./views/group.ts";

// German: every key probed below is genuinely translated there. Loanwords and
// protected terms that are identical across catalogs (key_esc "Esc",
// channel_label_ntfy, channel_field_topic "Topic") are deliberately not probed;
// the differs-from-English guard below fails the suite if one ever creeps in.
const TARGET: Locale = "de";

const originalGetLocale = runtime.getLocale;
afterAll(() => runtime.overwriteGetLocale(originalGetLocale));

type Message = (
	inputs?: Record<string, never>,
	options?: { locale?: Locale },
) => string;

function selectOption(field: "kind" | "due", operator: string, value: string) {
	const control = metaFor(field).controlFor(operator);
	if (control.kind !== "select")
		throw new Error(`expected a select control for ${field}/${operator}`);
	const option = control.options.find((o) => o.value === value);
	if (!option) throw new Error(`no ${field} option '${value}'`);
	return option.label;
}

function dueGroupLabel(key: string): string {
	const group = groupTasks(
		[
			{
				id: "t",
				listId: "l",
				title: "T",
				done: false,
				dueAt: new Date("2000-01-01T00:00:00Z"),
				priority: 0,
				assigneeIds: [],
				labelIds: [],
			},
		],
		"due",
		{
			now: new Date("2026-07-13T12:00:00Z"),
			listTitle: (id) => id,
			memberName: (id) => id,
			labelName: (id) => id,
		},
	).find((g) => g.key === key);
	if (!group) throw new Error(`no due group '${key}'`);
	return group.label;
}

function commandLabel(id: string): string {
	const command = COMMANDS.find((c) => c.id === id);
	if (!command) throw new Error(`no command '${id}'`);
	return command.label;
}

function priorityOptionLabel(value: number): string {
	const entry = PRIORITIES.find((p) => p.value === value);
	if (!entry) throw new Error(`no priority option '${value}'`);
	return entry.label;
}

// name -> [what the module exposes, the catalog key it must track]
const PROBES: [string, () => string, Message][] = [
	[
		"commands.ts COMMANDS",
		() => commandLabel("palette.open"),
		m.command_palette_open,
	],
	[
		"category-label.ts CATEGORY_LABELS",
		() => categoryLabel("general"),
		m.cheatsheet_category_general,
	],
	[
		"task-display.ts PRIORITY_LABELS",
		() => priorityLabel(2),
		m.priority_medium,
	],
	[
		"task-display.ts PRIORITY_LABELS_SHORT",
		() => priorityLabelShort(2),
		m.priority_medium_short,
	],
	["task-display.ts PRIORITIES", () => priorityOptionLabel(3), m.priority_high],
	["role-labels.ts ROLE_LABELS", () => ROLE_LABELS.owner(), m.role_label_owner],
	["PanelFrame.tsx SIZE_LABEL", () => SIZE_LABEL.s(), m.panel_size_small],
	[
		"filter-options.ts SORT_FIELD_LABELS",
		() => SORT_FIELD_LABELS.sortKey(),
		m.sort_manual,
	],
	[
		"filter-options.ts FIELD_METAS",
		() => metaFor("due").label,
		m.task_field_due,
	],
	[
		"filter-options.ts OPERATOR_LABELS",
		() => metaFor("due").operators[0].label,
		m.filter_op_is,
	],
	[
		"filter-options.ts KIND_LABELS/KIND_OPTIONS",
		() => selectOption("kind", "eq", "shopping"),
		m.list_kind_shopping,
	],
	[
		"filter-options.ts DUE_LITERAL_OPTIONS",
		() => selectOption("due", "is", "today"),
		m.due_today,
	],
	[
		"karma-format.ts REASON_LABELS",
		() => reasonLabel("task_complete"),
		m.karma_reason_task_complete,
	],
	[
		"channel-messages.ts CHANNEL_LABELS",
		() => channelLabel("email"),
		m.channel_label_email,
	],
	[
		"channel-messages.ts ERROR_MESSAGES",
		() => channelErrorMessage("auth"),
		m.channel_error_auth,
	],
	[
		"channel-messages.ts FIELD_LABELS",
		() => channelFieldLabel("serverUrl"),
		m.channel_field_serverUrl,
	],
	[
		"channel-messages.ts WARNING_MESSAGES",
		() => channelWarningMessage("app_mode_no_public_url"),
		m.channel_mode_app_degraded,
	],
	[
		"channel-messages.ts SAVE_ERROR_MESSAGES",
		() => channelSaveErrorMessage("invalid_config"),
		m.channel_save_invalid_config,
	],
	["binding-label.ts WORD_LABELS", () => formatBinding([" "]), m.key_space],
	[
		"builtins.ts BUILTIN_VIEWS",
		() => BUILTIN_VIEWS[0].name,
		m.builtin_view_today,
	],
	["group.ts DUE_LABELS", () => dueGroupLabel("overdue"), m.due_overdue],
];

describe("module-level translated constants are not locale-frozen", () => {
	it.each(PROBES)("%s", (name, read, message) => {
		const english = message({}, { locale: "en" });
		const translated = message({}, { locale: TARGET });
		// Without this the probe would be vacuous for any key whose translation
		// happens to equal English -- a frozen constant would still "pass".
		expect(
			translated,
			`${name}: catalog key is identical in en and ${TARGET}; pick another key`,
		).not.toBe(english);

		runtime.overwriteGetLocale(() => "en");
		expect(read()).toBe(english);
		runtime.overwriteGetLocale(() => TARGET);
		expect(read()).toBe(translated);
	});
});

// The probes above can only reach exported constants. Most of the label maps in
// this codebase are module-private inside .tsx components (MIN_FIELDS,
// GOAL_FIELDS, TYPE_OPTIONS, FREQ_LABELS, LAYOUT_LABELS, ...), so the same
// invariant is enforced statically for every source file: no `m.x()` call may
// be evaluated at module scope. Anything inside a function, arrow or getter is
// fine -- that is the whole point of the accessor pattern.
function eagerModuleScopeCalls(file: ts.SourceFile): string[] {
	const found: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isFunctionLike(node) ||
			ts.isClassDeclaration(node) ||
			ts.isClassExpression(node)
		)
			return;
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === "m"
		) {
			const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
			found.push(
				`${file.fileName}:${line + 1} m.${node.expression.name.text}()`,
			);
		}
		ts.forEachChild(node, visit);
	};
	for (const statement of file.statements) {
		if (ts.isVariableStatement(statement)) visit(statement);
	}
	return found;
}

describe("no module-scope eager message resolution", () => {
	it("every m.*() call in src/ sits behind a function, arrow or getter", () => {
		const root = fileURLToPath(new URL("..", import.meta.url));
		const offenders: string[] = [];
		for (const entry of readdirSync(root, {
			recursive: true,
			withFileTypes: true,
		})) {
			if (!entry.isFile()) continue;
			if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name))
				continue;
			const path = join(entry.parentPath, entry.name);
			if (path.includes(`${sep}paraglide${sep}`)) continue;
			const source = readFileSync(path, "utf8");
			if (!source.includes("paraglide/messages.js")) continue;
			offenders.push(
				...eagerModuleScopeCalls(
					ts.createSourceFile(
						relative(root, path),
						source,
						ts.ScriptTarget.ESNext,
						true,
						ts.ScriptKind.TSX,
					),
				),
			);
		}
		expect(offenders).toEqual([]);
	});
});
