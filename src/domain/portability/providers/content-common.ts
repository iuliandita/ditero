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
	"row-skipped",
	"field-truncated",
	"field-invalid",
	"archived-completed",
	"recurrence-anchor",
	"date-order",
	"private-items",
	"row-ragged",
] as const;
export type NoticeCode = (typeof NOTICE_CODES)[number];
export interface ContentNotice {
	code: NoticeCode;
	path: string;
	count: number;
}
export type DateOrder = "mdy" | "dmy";
export interface ContentOptions extends ProviderImportOptions {
	exportedAt: string;
	projectFolderName: string;
	unsectionedListName: string;
	timezone: string;
	// Microsoft only: "auto" is resolved from the file or rejected when ambiguous.
	dateOrder?: DateOrder | "auto" | null;
	// Todoist only: first occurrence of recurring tasks whose export dropped its start date.
	anchorDay?: string | null;
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
	dateOrder: DateOrder | null;
	anchorDay: string | null;
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
export interface CsvRow {
	record: Record<string, string>;
	// Spreadsheet-style record number: the first record of the file is 1.
	number: number;
	short: boolean;
}
export function csvRecords(
	input: Uint8Array,
	headerStart?: string,
	options: ProviderImportOptions = {},
	tolerant = false,
) {
	const checkpoint = providerCheckpoint(options);
	const rows = parseProviderCsvCells(
		decodeContent(input),
		checkpoint,
		64,
		tolerant,
	);
	const start = headerStart
		? rows.findIndex((row) => row[0] === headerStart)
		: 0;
	if (
		start < 0 ||
		(headerStart &&
			(start > 8 ||
				rows
					.slice(0, start)
					.some(
						(row) =>
							row.some(Boolean) &&
							!/^(Date|Version|Status)(:|$)/.test(row[0] ?? ""),
					)))
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
		throw new ProviderImportError("invalid-csv", start + 1);
	const parsed: CsvRow[] = [];
	// Long rows in tolerant mode cannot be aligned to the header, so callers skip them.
	const misaligned: number[] = [];
	for (const [index, row] of rows.slice(start + 1).entries()) {
		checkpoint();
		if (!row.some(Boolean)) continue;
		const number = start + index + 2;
		if (row.length > header.length && tolerant) {
			misaligned.push(number);
			continue;
		}
		if (
			row.length !== header.length &&
			!(tolerant && row.length < header.length)
		)
			throw new ProviderImportError("invalid-csv", number);
		parsed.push({
			record: Object.fromEntries(header.map((key, i) => [key, row[i] ?? ""])),
			number,
			short: row.length < header.length,
		});
	}
	return { header, rows: parsed, misaligned };
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
		// Large enough for every IANA zone, so rotating row zones never thrash the cache.
		if (formatters.size >= 1024) formatters.clear();
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
function wallInstants(naive: string, epoch: number, zone: string): number[] {
	const offsets = new Set(
		[-86_400_000, 0, 86_400_000].map(
			(delta) =>
				Date.parse(`${wallTime(epoch + delta, zone)}Z`) - epoch - delta,
		),
	);
	return [...offsets]
		.map((offset) => epoch - offset)
		.filter((instant) => wallTime(instant, zone) === naive)
		.sort((a, b) => a - b);
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
	if (!match[2]) {
		// A calendar day has no clock: use its first real instant, even when midnight
		// does not exist in the zone (DST gap) or happens twice.
		for (let minute = 0; minute <= 300; minute += 30) {
			const wall = `${day}T${String((minute / 60) | 0).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00`;
			const [first] = wallInstants(wall, Date.parse(`${wall}Z`), zone);
			if (first !== undefined)
				return { dueAt: new Date(first).toISOString(), dueAllDay: true };
		}
		throw new ProviderImportError("invalid-date");
	}
	// Reject gaps and folds rather than silently choosing an instant at a DST transition.
	const candidates = wallInstants(naive, epoch, zone);
	if (candidates.length !== 1) throw new ProviderImportError("invalid-date");
	return {
		dueAt: new Date(
			(candidates[0] ?? NaN) +
				Number(
					(/\.(\d+)/.exec(normalized)?.[1] ?? "").padEnd(3, "0").slice(0, 3),
				),
		).toISOString(),
		dueAllDay: false,
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
// Failures a single row or value can cause; structural and resource errors stay fatal.
const ROW_CODES: readonly string[] = ["invalid-row", "field-limit"];
const FALSE_TEXT = new Set([
	"false",
	"FALSE",
	"False",
	"N",
	"n",
	"0",
	"0%",
	"Normal",
]);
export const TITLE_LIMIT = 500;
// Per-row notices keep their location; later ones fold into one "more" entry.
const LOCATED_LIMIT = 300;
export class ContentBuilder {
	readonly checkpoint: () => void;
	readonly notices: ContentNotice[] = [];
	readonly tasks = new Map<string, DraftTask>();
	readonly lists = new Map<string, { title: string; folder: string | null }>();
	readonly folders = new Map<string, string>();
	// Location prefix of the row being converted, for example "row:12".
	at = "";
	// Resolved by the Microsoft adapter; every other provider leaves it null.
	dateOrder: DateOrder | null = null;
	anchorDay: string | null = null;
	private located = 0;
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
		if (found) found.count = Math.min(found.count + 1, 50_000);
		else {
			// Leave room for one entry per code so the 512 notice bound never fails a file.
			const shown = this.notices.length >= 480 ? "more" : path;
			const entry = this.notices.find(
				(notice) => notice.code === code && notice.path === shown,
			);
			if (entry) entry.count = Math.min(entry.count + 1, 50_000);
			else this.notices.push({ code, path: string(shown, 512), count: 1 });
		}
	}
	// Notice tied to the current row (and optionally one of its fields).
	noticeAt(code: NoticeCode, field?: string) {
		if (!this.at) return this.notice(code, field ?? "export");
		if (this.located >= LOCATED_LIMIT) return this.notice(code, "more");
		this.located++;
		this.notice(code, field ? `${this.at}:${field}` : this.at);
	}
	// Convert one row; a bad row becomes a located notice instead of failing the file.
	row(at: string, convert: () => void) {
		this.at = at;
		try {
			convert();
		} catch (error) {
			if (!(error instanceof ProviderImportError)) throw error;
			if (!ROW_CODES.includes(error.code)) throw error;
			this.noticeAt("row-skipped");
		} finally {
			this.at = "";
		}
	}
	skipped(at: string) {
		this.at = at;
		this.noticeAt("row-skipped");
		this.at = "";
	}
	// Boolean cell; an unreadable value counts as false and is reported.
	flag(value: string | undefined, field: string): boolean {
		try {
			return flag(value);
		} catch {
			this.noticeAt("field-invalid", field);
			return false;
		}
	}
	// Free text is shortened to the product's character limit instead of failing the file.
	text(value: string, field: string, max = TITLE_LIMIT): string {
		let result = value.replaceAll("\u0000", "");
		if (!result.isWellFormed()) result = result.toWellFormed();
		const points = [...result];
		if (points.length > max) {
			this.noticeAt("field-truncated", field);
			result = points.slice(0, max).join("");
		}
		return result;
	}
	// Notes are bounded in bytes by the converted document; cut at a code point boundary.
	notes(value: string, field: string): string {
		let result = value.replaceAll("\u0000", "");
		if (!result.isWellFormed()) result = result.toWellFormed();
		const limit = PROVIDER_MAX_FIELD_BYTES - 1;
		const encoder = new TextEncoder();
		if (encoder.encode(result).byteLength <= limit) return result;
		this.noticeAt("field-truncated", field);
		// encodeInto stops at the last whole code point that fits, in linear time.
		const buffer = new Uint8Array(limit);
		const { written } = encoder.encodeInto(result, buffer);
		return new TextDecoder().decode(buffer.subarray(0, written));
	}
	unsupported(row: Record<string, unknown>, supported: readonly string[]) {
		for (const [key, value] of Object.entries(row)) {
			if (
				!supported.includes(key) &&
				value !== "" &&
				value !== null &&
				value !== undefined &&
				value !== false &&
				!(typeof value === "string" && FALSE_TEXT.has(value)) &&
				(!Array.isArray(value) || value.length)
			)
				this.notice("unsupported-field", key);
		}
	}
	list(id: string, title: string, folder: string | null = null) {
		nonempty(id, 4 * TITLE_LIMIT);
		nonempty(title, 4 * TITLE_LIMIT);
		if (folder) {
			nonempty(folder, 4 * TITLE_LIMIT);
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
		nonempty(task.title, 4 * TITLE_LIMIT);
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
	// A date without a time has no zone: it always lands on the importer's calendar day.
	date(value: string, zone = this.options.timezone, field?: string) {
		const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
		try {
			return contentDate(value, dateOnly ? this.options.timezone : zone);
		} catch {
			this.noticeAt("unsupported-date", field);
			return { dueAt: null, dueAllDay: false };
		}
	}
	recurrence(value: string, field?: string): string | null {
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
		this.noticeAt("unsupported-recurrence", field);
		return null;
	}
	appendNote(task: DraftTask, note: string, field = "note") {
		if (!note) return;
		const room = [task.notes, note].filter(Boolean).join("\n\n");
		task.notes = this.notes(room, field);
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
					nonempty(label, 4 * TITLE_LIMIT);
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
					color: "gray",
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
			dateOrder: this.dateOrder,
			anchorDay: this.anchorDay,
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
