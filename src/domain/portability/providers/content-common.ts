import { generateNKeysBetween } from "fractional-indexing";
import { parseRule } from "../../recurrence.ts";
import { validateImportGraph } from "../graph.ts";
import type { PortableExportV1, PortableRows } from "../v1.ts";
import {
	parseBoundedPortableJson,
	parsePortableExportV1,
} from "../validate.ts";
import {
	checkProviderText,
	PROVIDER_MAX_BYTES,
	PROVIDER_MAX_FIELD_BYTES,
	PROVIDER_MAX_ROWS,
	ProviderImportError,
	type ProviderImportOptions,
	providerCheckpoint,
	snapshotNamespace,
} from "./common.ts";
import { parseProviderCsvCells } from "./csv-cells.ts";
import { todoistSnapshotSha256 } from "./todoist.ts";

export const CONTENT_ADAPTER = "provider-content";
export const CONTENT_PROVIDERS = [
	"todoist",
	"ticktick",
	"microsoft",
	"trello",
	"generic-csv",
] as const;
export type ContentProvider = (typeof CONTENT_PROVIDERS)[number];
export const NOTICE_CODES = [
	"unsupported-field",
	"unsupported-date",
	"unsupported-recurrence",
	"flattened-subtasks",
	"duplicate-row",
	"comments-as-notes",
	"people-excluded",
	"attachments-excluded",
	"reminders-disabled",
	"history-excluded",
	"archive-state",
	"partial-export",
	"completion-unavailable",
	"format-limits",
	"timezone-recurrence",
	"unknown-state",
] as const;
export type NoticeCode = (typeof NOTICE_CODES)[number];
export interface ContentNotice {
	code: NoticeCode;
	path: string;
	count: number;
}
export interface ContentOptions extends ProviderImportOptions {
	exportedAt: string;
	projectFolderName: string;
	unsectionedListName: string;
	timezone: string;
}
export interface ContentConversion {
	adapter: typeof CONTENT_ADAPTER;
	adapterVersion: 1;
	provider: ContentProvider;
	sourceNamespace: string;
	identityMode: "snapshot-rows";
	snapshotSha256: string;
	projectFolderName: string;
	unsectionedListName: string;
	timezone: string;
	notices: ContentNotice[];
	document: PortableExportV1;
}

export function decodeContent(input: Uint8Array): string {
	if (input.byteLength > PROVIDER_MAX_BYTES)
		throw new ProviderImportError("byte-limit");
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(input);
	} catch {
		throw new ProviderImportError("invalid-encoding");
	}
}
export function contentJson(input: Uint8Array): Record<string, unknown> {
	try {
		const parsed = record(parseBoundedPortableJson(decodeContent(input)));
		const pending: unknown[] = [parsed];
		while (pending.length) {
			const next = pending.pop();
			if (!next || typeof next !== "object") continue;
			for (const [key, value] of Object.entries(next)) {
				if (["__proto__", "prototype", "constructor"].includes(key))
					throw new ProviderImportError("invalid-json");
				pending.push(value);
			}
		}
		return parsed;
	} catch (error) {
		if (error instanceof ProviderImportError) throw error;
		throw new ProviderImportError("invalid-json");
	}
}
export function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ProviderImportError("invalid-row");
	return value as Record<string, unknown>;
}
export function items(value: unknown): unknown[] {
	if (!Array.isArray(value) || value.length > PROVIDER_MAX_ROWS)
		throw new ProviderImportError("invalid-row");
	return value;
}
export function string(value: unknown, max = 500): string {
	if (typeof value !== "string") throw new ProviderImportError("invalid-row");
	checkProviderText(value, max);
	return value;
}
export function nonempty(value: unknown, max = 500): string {
	const text = string(value, max);
	if (!text.trim()) throw new ProviderImportError("invalid-row");
	return text;
}
export function flag(value: unknown, fallback = false): boolean {
	if (value === undefined || value === null || value === "") return fallback;
	if (
		value === true ||
		value === "true" ||
		value === "TRUE" ||
		value === "1" ||
		value === "Y"
	)
		return true;
	if (
		value === false ||
		value === "false" ||
		value === "FALSE" ||
		value === "0" ||
		value === "N"
	)
		return false;
	throw new ProviderImportError("invalid-row");
}
export function csvRecords(
	input: Uint8Array,
	headerStart?: string,
	options: ProviderImportOptions = {},
) {
	const checkpoint = providerCheckpoint(options);
	const rows = parseProviderCsvCells(decodeContent(input), checkpoint, 64);
	const start = headerStart
		? rows.findIndex((row) => row[0] === headerStart)
		: 0;
	if (
		headerStart &&
		(start > 8 ||
			rows
				.slice(0, start)
				.some(
					(row) =>
						row.some(Boolean) &&
						!/^(Date|Version|Status)(:|$)/.test(row[0] ?? ""),
				))
	)
		throw new ProviderImportError("invalid-csv");
	const header = rows[start];
	if (
		!header?.length ||
		new Set(header).size !== header.length ||
		header.some(
			(key) => !key || ["__proto__", "prototype", "constructor"].includes(key),
		)
	)
		throw new ProviderImportError("invalid-csv");
	return {
		header,
		rows: rows
			.slice(start + 1)
			.filter((row) => row.some(Boolean))
			.map((row, index) => {
				checkpoint();
				if (row.length !== header.length)
					throw new ProviderImportError("invalid-csv", start + index + 2);
				return Object.fromEntries(header.map((key, i) => [key, row[i] ?? ""]));
			}),
	};
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(zone: string) {
	let formatter = formatters.get(zone);
	if (!formatter) {
		try {
			formatter = new Intl.DateTimeFormat("en-CA", {
				timeZone: zone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				hourCycle: "h23",
			});
		} catch {
			throw new ProviderImportError("invalid-date");
		}
		if (formatters.size >= 128) formatters.clear();
		formatters.set(zone, formatter);
	}
	return formatter;
}
function wallTime(instant: number, zone: string): string {
	const parts = Object.fromEntries(
		zoneFormatter(zone)
			.formatToParts(instant)
			.map((part) => [part.type, part.value]),
	);
	return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
export function contentDate(
	value: string,
	zone: string,
): { dueAt: string | null; dueAllDay: boolean } {
	if (!value) return { dueAt: null, dueAllDay: false };
	const normalized = value
		.trim()
		.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")
		.replace(" ", "T");
	const match =
		/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::(\d{2})(?:\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(
			normalized,
		);
	if (!match) throw new ProviderImportError("invalid-date");
	const day = match[1] ?? "";
	const naive = `${day}T${match[2] ?? "00:00"}:${match[3] ?? "00"}`;
	const epoch = Date.parse(`${naive}Z`);
	if (
		!Number.isFinite(epoch) ||
		new Date(epoch).toISOString().slice(0, 19) !== naive
	)
		throw new ProviderImportError("invalid-date");
	if (match[4]) {
		const instant = Date.parse(normalized);
		if (!Number.isFinite(instant))
			throw new ProviderImportError("invalid-date");
		return { dueAt: new Date(instant).toISOString(), dueAllDay: false };
	}
	// Reject gaps and folds rather than silently choosing an instant at a DST transition.
	const offsets = new Set(
		[-86_400_000, 0, 86_400_000].map(
			(delta) =>
				Date.parse(`${wallTime(epoch + delta, zone)}Z`) - epoch - delta,
		),
	);
	const candidates = [...offsets]
		.map((offset) => epoch - offset)
		.filter((instant) => wallTime(instant, zone) === naive);
	if (candidates.length !== 1) throw new ProviderImportError("invalid-date");
	return {
		dueAt: new Date(
			(candidates[0] ?? NaN) +
				Number(
					(/\.(\d+)/.exec(normalized)?.[1] ?? "").padEnd(3, "0").slice(0, 3),
				),
		).toISOString(),
		dueAllDay: !match[2],
	};
}

export interface DraftTask {
	id: string;
	listId: string;
	title: string;
	parentId?: string | null;
	notes?: string | null;
	dueAt?: string | null;
	dueAllDay?: boolean;
	done?: boolean;
	completedAt?: string | null;
	priority?: number;
	rrule?: string | null;
	labels?: string[];
}
export class ContentBuilder {
	readonly checkpoint: () => void;
	readonly notices: ContentNotice[] = [];
	readonly tasks = new Map<string, DraftTask>();
	readonly lists = new Map<string, { title: string; folder: string | null }>();
	readonly folders = new Map<string, string>();
	constructor(
		readonly provider: ContentProvider,
		readonly options: ContentOptions,
	) {
		this.checkpoint = providerCheckpoint(options);
		for (const name of [options.projectFolderName, options.unsectionedListName])
			nonempty(name);
		zoneFormatter(options.timezone);
		this.notice("people-excluded");
		this.notice("attachments-excluded");
		this.notice("reminders-disabled");
		this.notice("history-excluded");
	}
	notice(code: NoticeCode, path = "export") {
		const found = this.notices.find(
			(notice) => notice.code === code && notice.path === path,
		);
		if (found) found.count++;
		else {
			if (this.notices.length >= 512)
				throw new ProviderImportError("row-limit");
			this.notices.push({ code, path: string(path, 512), count: 1 });
		}
	}
	unsupported(row: Record<string, unknown>, supported: readonly string[]) {
		for (const [key, value] of Object.entries(row)) {
			if (
				!supported.includes(key) &&
				value !== "" &&
				value !== null &&
				value !== undefined &&
				value !== false &&
				(!Array.isArray(value) || value.length)
			)
				this.notice("unsupported-field", key);
		}
	}
	list(id: string, title: string, folder: string | null = null) {
		nonempty(id);
		nonempty(title);
		if (folder) {
			nonempty(folder);
			this.folders.set(folder, folder);
		}
		const previous = this.lists.get(id);
		if (previous && (previous.title !== title || previous.folder !== folder))
			throw new ProviderImportError("invalid-graph");
		this.lists.set(id, { title, folder });
		return id;
	}
	task(task: DraftTask) {
		this.checkpoint();
		nonempty(task.id);
		nonempty(task.title);
		if (!this.lists.has(task.listId))
			throw new ProviderImportError("invalid-graph");
		if (task.notes) string(task.notes, PROVIDER_MAX_FIELD_BYTES - 1);
		const previous = this.tasks.get(task.id);
		if (previous) {
			if (JSON.stringify(previous) !== JSON.stringify(task))
				throw new ProviderImportError("invalid-graph");
			this.notice("duplicate-row");
			return;
		}
		this.tasks.set(task.id, task);
		if (
			this.tasks.size + this.lists.size + this.folders.size + 3 >
			PROVIDER_MAX_ROWS
		)
			throw new ProviderImportError("row-limit");
	}
	date(value: string, zone = this.options.timezone) {
		try {
			return contentDate(value, zone);
		} catch {
			this.notice("unsupported-date");
			return { dueAt: null, dueAllDay: false };
		}
	}
	recurrence(value: string): string | null {
		if (!value) return null;
		const simple = new Map([
			["every day", "FREQ=DAILY"],
			["every week", "FREQ=WEEKLY"],
			["every month", "FREQ=MONTHLY"],
			["every year", "FREQ=YEARLY"],
			["every weekday", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"],
		]);
		const rule =
			simple.get(value.toLowerCase()) ?? value.replace(/^RRULE:/, "");
		// Timed timezone recurrence, relative rules and unknown extensions are not equivalent.
		if (
			/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+-]+)*$/.test(
				rule,
			) &&
			!/(?:^|;)(?:TZID|BYHOUR|BYMINUTE|BYSECOND|DTSTART)=/.test(rule) &&
			new Set(rule.split(";").map((field) => field.split("=")[0])).size ===
				rule.split(";").length
		) {
			try {
				const parsed = parseRule(rule);
				if (
					!Number.isSafeInteger(parsed.options.interval) ||
					parsed.options.interval <= 0 ||
					(parsed.options.count !== null &&
						(!Number.isSafeInteger(parsed.options.count) ||
							parsed.options.count <= 0))
				)
					throw new Error("Invalid recurrence bounds");
				return rule;
			} catch {
				/* Report the original expression. */
			}
		}
		this.notice("unsupported-recurrence");
		return null;
	}
	appendNote(task: DraftTask, note: string) {
		if (!note) return;
		task.notes = [task.notes, note].filter(Boolean).join("\n\n");
		string(task.notes, PROVIDER_MAX_FIELD_BYTES - 1);
	}
	async finish(input: Uint8Array): Promise<ContentConversion> {
		const snapshotSha256 = await todoistSnapshotSha256(input, this.options);
		const sourceNamespace = snapshotNamespace(snapshotSha256);
		const prefix = `provider:1:${this.provider}:${sourceNamespace}`;
		const id = (kind: string, key: string) =>
			`${prefix}:${kind}:${encodeURIComponent(key)}`;
		const owner = `${prefix}:owner`,
			workspace = `${prefix}:workspace`;
		const folderKeys = generateNKeysBetween(null, null, this.folders.size);
		const listKeys = generateNKeysBetween(null, null, this.lists.size);
		const taskKeys = generateNKeysBetween(null, null, this.tasks.size);
		const roots = new Map<string, string>();
		for (const task of this.tasks.values()) {
			this.checkpoint();
			const chain = new Set<string>();
			let current = task;
			while (current.parentId) {
				this.checkpoint();
				if (chain.has(current.id))
					throw new ProviderImportError("invalid-graph");
				chain.add(current.id);
				const parent = this.tasks.get(current.parentId);
				if (!parent || parent.listId !== task.listId)
					throw new ProviderImportError("invalid-graph");
				const known = roots.get(parent.id);
				if (known) {
					current = this.tasks.get(known) ?? parent;
					break;
				}
				current = parent;
			}
			roots.set(task.id, current.id);
			for (const child of chain) roots.set(child, current.id);
			if (task.parentId && task.parentId !== current.id)
				this.notice("flattened-subtasks");
		}
		const labels = new Map<string, string>();
		const taskLabels: PortableRows["taskLabels"][] = [];
		const tasks: PortableRows["tasks"][] = [...this.tasks.values()].map(
			(task, index) => {
				for (const label of new Set(task.labels ?? [])) {
					nonempty(label, 500);
					labels.set(label, id("label", label));
					taskLabels.push({
						id: id("task-label", JSON.stringify([task.id, label])),
						taskId: id("task", task.id),
						labelId: id("label", label),
					});
				}
				let rule = task.rrule ?? null;
				if (rule && (!task.dueAt || !task.dueAllDay)) {
					this.notice("timezone-recurrence");
					rule = null;
				}
				return {
					id: id("task", task.id),
					listId: id("list", task.listId),
					title: task.title,
					notes: task.notes || null,
					parentId: task.parentId ? id("task", roots.get(task.id) ?? "") : null,
					done: task.done ?? false,
					completedAt: task.completedAt ?? null,
					dueAt: task.dueAt ?? null,
					dueAllDay: task.dueAllDay ?? false,
					priority: task.priority ?? 0,
					sortKey: taskKeys[index] ?? "",
					rrule: rule,
					recurrenceRelative: false,
					quantity: null,
					unit: null,
					category: null,
					reminderTime: null,
					repeatEveryMin: null,
					maxRepeats: null,
					fallbackUserId: null,
					urgent: false,
				};
			},
		);
		const document: PortableExportV1 = {
			format: "ditero",
			schemaVersion: 1,
			exportedAt: this.options.exportedAt,
			sourceUserId: owner,
			boundaries: {
				attachmentContent: "excluded",
				encryptionKeys: "excluded",
				credentials: "excluded",
				managedAccounts: "excluded",
				restoreSupported: false,
				taskHistory: "current-state-and-habit-logs",
			},
			data: {
				principals: [{ id: owner, name: "Untrusted migration owner" }],
				workspaces: [
					{
						id: workspace,
						name: `${this.provider} migration`,
						ownerId: owner,
						kind: "personal",
					},
				],
				memberships: [
					{
						id: `${prefix}:membership`,
						userId: owner,
						workspaceId: workspace,
						role: "owner",
					},
				],
				folders: [...this.folders.entries()].map(([key, name], index) => ({
					id: id("folder", key),
					name,
					workspaceId: workspace,
					sortKey: folderKeys[index] ?? "",
				})),
				lists: [...this.lists.entries()].map(([key, list], index) => ({
					id: id("list", key),
					title: list.title,
					folderId: list.folder ? id("folder", list.folder) : null,
					workspaceId: workspace,
					ownerId: owner,
					kind: "tasks",
					icon: null,
					sortKey: listKeys[index] ?? "",
					completedDisplay: "sink",
				})),
				tasks,
				labels: [...labels.entries()].map(([name, labelId]) => ({
					id: labelId,
					name,
					workspaceId: workspace,
					color: "#64748b",
				})),
				taskLabels,
				assignments: [],
				comments: [],
				templates: [],
				habitLogs: [],
				focusSessions: [],
				views: [],
				dashboards: [],
				userPrefs: [],
				karma: [],
				karmaEvents: [],
				attachments: [],
			},
		};
		const result: ContentConversion = {
			adapter: CONTENT_ADAPTER,
			adapterVersion: 1,
			provider: this.provider,
			sourceNamespace,
			identityMode: "snapshot-rows",
			snapshotSha256,
			projectFolderName: this.options.projectFolderName,
			unsectionedListName: this.options.unsectionedListName,
			timezone: this.options.timezone,
			notices: this.notices,
			document,
		};
		validateContentConversion(result, this.options);
		return result;
	}
}

export function validateContentConversion(
	result: ContentConversion,
	options: ProviderImportOptions = {},
) {
	const checkpoint = providerCheckpoint(options);
	const document = parsePortableExportV1(JSON.stringify(result.document));
	const prefix = `provider:1:${result.provider}:${result.sourceNamespace}`;
	if (
		snapshotNamespace(result.snapshotSha256) !== result.sourceNamespace ||
		document.sourceUserId !== `${prefix}:owner`
	)
		throw new ProviderImportError("invalid-result");
	const allowed = new Set([
		"principals",
		"workspaces",
		"memberships",
		"folders",
		"lists",
		"tasks",
		"labels",
		"taskLabels",
	]);
	if (
		Object.entries(document.data).some(
			([key, rows]) => !allowed.has(key) && rows.length,
		)
	)
		throw new ProviderImportError("unsupported-content");
	for (const [key, rows] of Object.entries(document.data))
		for (const row of rows) {
			checkpoint();
			if ("id" in row && !row.id.startsWith(`${prefix}:`))
				throw new ProviderImportError("invalid-result");
			if (key === "tasks") {
				const task = row as PortableRows["tasks"];
				if (
					task.reminderTime !== null ||
					task.repeatEveryMin !== null ||
					task.maxRepeats !== null ||
					task.fallbackUserId !== null ||
					task.urgent ||
					task.recurrenceRelative
				)
					throw new ProviderImportError("unsupported-content");
			}
		}
	if (!validateImportGraph(document, checkpoint).valid)
		throw new ProviderImportError("invalid-graph");
	return document;
}
