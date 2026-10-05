import { generateNKeysBetween } from "fractional-indexing";
import type { PortableExportV1, PortableRows } from "../v1.ts";
import {
	PortableExportValidationError,
	parseBoundedPortableJson,
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
	TRELLO_ADAPTER,
	TRELLO_ADAPTER_VERSION,
	TRELLO_NAMESPACE_DOMAIN,
	type TrelloConversionResult,
	trelloSourceUserId,
	validateProviderConversion,
} from "./common.ts";

type JsonObject = Record<string, unknown>;
interface Placed {
	id: string;
	pos: number;
	name: string;
}
interface PlacedCard extends Placed {
	listId: string;
	notes: string | null;
}

async function sha256Hex(
	bytes: Uint8Array,
	checkpoint: () => void,
): Promise<string> {
	checkpoint();
	if (bytes.byteLength > PROVIDER_MAX_BYTES)
		throw new ProviderImportError("byte-limit");
	if (!globalThis.crypto?.subtle)
		throw new ProviderImportError("secure-context-required");
	const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
	checkpoint();
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

// The fingerprint of the exact bytes the person selected.
export function trelloSnapshotSha256(
	bytes: Uint8Array,
	options: ProviderImportOptions = {},
): Promise<string> {
	return sha256Hex(bytes, providerCheckpoint(options));
}

function object(
	value: unknown,
	code: "invalid-metadata" | "invalid-row",
	row?: number,
): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ProviderImportError(code, row);
	return value as JsonObject;
}
// Own properties only; parsed JSON can carry keys such as "constructor".
function field(source: JsonObject, key: string): unknown {
	return Object.hasOwn(source, key) ? source[key] : undefined;
}
// Trello IDs are case-insensitive 24-character hex; canonical form is lowercase.
function trelloId(value: unknown, row?: number): string {
	if (typeof value !== "string" || !/^[0-9a-fA-F]{24}$/.test(value))
		throw new ProviderImportError("invalid-row", row);
	return value.toLowerCase();
}
function text(value: unknown, maxBytes: number, row?: number): string {
	if (typeof value !== "string" || !value.trim())
		throw new ProviderImportError("invalid-row", row);
	checkProviderText(value, maxBytes, row);
	return value;
}
function position(value: unknown, row?: number): number {
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new ProviderImportError("invalid-row", row);
	return value;
}
// Archived entities are never completed work; refuse rather than shrink or reinterpret.
function open(value: unknown, row?: number) {
	if (typeof value !== "boolean")
		throw new ProviderImportError("invalid-row", row);
	if (value) throw new ProviderImportError("unsupported-content", row);
}
// An absent flag means false; true is an unsupported state, anything else is malformed.
function absentOrFalse(value: unknown, row?: number) {
	if (value === undefined || value === false) return;
	throw new ProviderImportError(
		value === true ? "unsupported-content" : "invalid-row",
		row,
	);
}
function compare(left: Placed, right: Placed): number {
	if (left.pos !== right.pos) return left.pos < right.pos ? -1 : 1;
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new ProviderImportError("invalid-metadata");
	return value;
}

function parseJson(source: string, checkpoint: () => void): unknown {
	checkpoint();
	try {
		return parseBoundedPortableJson(source);
	} catch (error) {
		if (error instanceof ProviderImportError) throw error;
		if (!(error instanceof PortableExportValidationError))
			throw new ProviderImportError("invalid-json");
		switch (error.code) {
			case "byte-limit":
				throw new ProviderImportError("byte-limit");
			case "row-limit":
			case "array-limit":
			case "node-limit":
				throw new ProviderImportError("row-limit");
			case "invalid-text":
				throw new ProviderImportError("invalid-row");
			default:
				throw new ProviderImportError("invalid-json");
		}
	} finally {
		checkpoint();
	}
}

export async function parseTrelloBoardJson(
	input: Uint8Array,
	options: ProviderImportOptions & { exportedAt: string },
): Promise<TrelloConversionResult> {
	if (
		!options ||
		typeof options !== "object" ||
		(Object.getPrototypeOf(options) !== Object.prototype &&
			Object.getPrototypeOf(options) !== null)
	)
		throw new ProviderImportError("invalid-metadata");
	for (const key of Reflect.ownKeys(options)) {
		const property = Object.getOwnPropertyDescriptor(options, key);
		if (
			typeof key !== "string" ||
			!["signal", "deadline", "exportedAt"].includes(key) ||
			!property ||
			!("value" in property) ||
			!property.enumerable
		)
			throw new ProviderImportError("invalid-metadata");
	}
	const bounded = {
		...options,
		deadline: Math.min(
			options.deadline ?? Infinity,
			performance.now() + 15_000,
		),
	};
	const checkpoint = providerCheckpoint(bounded);
	checkpoint();
	const snapshotSha256 = await sha256Hex(input, checkpoint);
	let source: string;
	try {
		// Keep a byte-order mark so it fails as JSON instead of being dropped.
		source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			input,
		);
	} catch {
		throw new ProviderImportError("invalid-encoding");
	}
	const board = object(parseJson(source, checkpoint), "invalid-metadata");
	const boardId = trelloId(field(board, "id"));
	const boardName = text(field(board, "name"), 500);
	open(field(board, "closed"));
	const sourceLists = array(field(board, "lists"));
	const sourceCards = array(field(board, "cards"));
	if (sourceLists.length + sourceCards.length + 4 > PROVIDER_MAX_ROWS)
		throw new ProviderImportError("row-limit");

	const lists = new Map<string, Placed>();
	for (const [index, value] of sourceLists.entries()) {
		checkpoint();
		const row = index + 1;
		const list = object(value, "invalid-row", row);
		const id = trelloId(field(list, "id"), row);
		if (trelloId(field(list, "idBoard"), row) !== boardId)
			throw new ProviderImportError("invalid-graph", row);
		if (lists.has(id)) throw new ProviderImportError("invalid-graph", row);
		open(field(list, "closed"), row);
		lists.set(id, {
			id,
			pos: position(field(list, "pos"), row),
			name: text(field(list, "name"), 500, row),
		});
	}
	const cardIds = new Set<string>();
	const cards: PlacedCard[] = [];
	for (const [index, value] of sourceCards.entries()) {
		checkpoint();
		const row = index + 1;
		const card = object(value, "invalid-row", row);
		const id = trelloId(field(card, "id"), row);
		if (trelloId(field(card, "idBoard"), row) !== boardId)
			throw new ProviderImportError("invalid-graph", row);
		const listId = trelloId(field(card, "idList"), row);
		if (!lists.has(listId) || cardIds.has(id))
			throw new ProviderImportError("invalid-graph", row);
		cardIds.add(id);
		open(field(card, "closed"), row);
		const role = field(card, "cardRole");
		if (role !== undefined && role !== null)
			throw new ProviderImportError("unsupported-content", row);
		absentOrFalse(field(card, "isTemplate"), row);
		absentOrFalse(field(card, "dueComplete"), row);
		const desc = field(card, "desc");
		if (desc !== undefined && typeof desc !== "string")
			throw new ProviderImportError("invalid-row", row);
		checkProviderText(desc ?? "", PROVIDER_MAX_FIELD_BYTES - 1, row);
		cards.push({
			id,
			listId,
			pos: position(field(card, "pos"), row),
			name: text(field(card, "name"), 500, row),
			notes: desc || null,
		});
	}

	const orderedLists = [...lists.values()].sort(compare);
	const grouped = new Map<string, PlacedCard[]>();
	for (const card of cards.sort(compare)) {
		checkpoint();
		const group = grouped.get(card.listId) ?? [];
		group.push(card);
		grouped.set(card.listId, group);
	}

	const boardIdSha256 = await sha256Hex(
		new TextEncoder().encode(`${TRELLO_NAMESPACE_DOMAIN}${boardId}`),
		checkpoint,
	);
	const namespace = snapshotNamespace(boardIdSha256);
	const prefix = `trello:1:${namespace}`;
	const owner = trelloSourceUserId(namespace);
	const workspace = `${prefix}:workspace`;
	const folder = `${prefix}:folder:board`;
	const listKeys = generateNKeysBetween(null, null, orderedLists.length);
	const tasks: PortableRows["tasks"][] = [];
	for (const list of orderedLists) {
		checkpoint();
		const group = grouped.get(list.id) ?? [];
		const keys = generateNKeysBetween(null, null, group.length);
		for (const [index, card] of group.entries()) {
			checkpoint();
			const sortKey = keys[index];
			if (!sortKey) throw new ProviderImportError("invalid-result");
			tasks.push({
				id: `${prefix}:task:${card.id}`,
				listId: `${prefix}:list:${list.id}`,
				parentId: null,
				title: card.name,
				notes: card.notes,
				priority: 0,
				done: false,
				completedAt: null,
				dueAt: null,
				dueAllDay: false,
				sortKey,
				quantity: null,
				unit: null,
				category: null,
				rrule: null,
				recurrenceRelative: false,
				reminderTime: null,
				repeatEveryMin: null,
				maxRepeats: null,
				fallbackUserId: null,
				urgent: false,
			});
		}
	}
	const document: PortableExportV1 = {
		format: "ditero",
		schemaVersion: 1,
		exportedAt: options.exportedAt,
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
					name: "Trello board migration",
					ownerId: owner,
					kind: "personal",
				},
			],
			memberships: [
				{
					id: `${prefix}:membership`,
					workspaceId: workspace,
					userId: owner,
					role: "owner",
				},
			],
			folders: [
				{ id: folder, workspaceId: workspace, name: boardName, sortKey: "a0" },
			],
			lists: orderedLists.map((list, index) => ({
				id: `${prefix}:list:${list.id}`,
				title: list.name,
				workspaceId: workspace,
				ownerId: owner,
				kind: "tasks",
				icon: null,
				folderId: folder,
				sortKey: listKeys[index] ?? "",
				completedDisplay: "sink",
			})),
			tasks,
			labels: [],
			taskLabels: [],
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
	const result = validateProviderConversion(
		{
			adapter: TRELLO_ADAPTER,
			adapterVersion: TRELLO_ADAPTER_VERSION,
			sourceNamespace: namespace,
			identityMode: "stable-ids",
			snapshotSha256,
			boardIdSha256,
			document,
			findings: [{ code: "untrusted-migration-owner", path: "sourceUserId" }],
		},
		bounded,
	);
	if (result.adapter !== TRELLO_ADAPTER)
		throw new ProviderImportError("invalid-result");
	checkpoint();
	return result;
}
