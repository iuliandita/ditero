import { validateImportGraphV2 } from "./graph-v2.ts";
import { hashImportValue } from "./import-digest.ts";
import type { PortableJson } from "./v1.ts";
import type {
	PortableAuthorV2,
	PortableExportV2,
	PortableOriginV2,
	PortableRowsV2,
	PortableSourceRef,
} from "./v2.ts";

export type HistoricalCollection =
	| "comments"
	| "templates"
	| "completionEvents";

export type HistoricalLedgerTuple = {
	collection: HistoricalCollection;
	targetParentId: string;
	sourceNamespace: string;
	sourceIdHash: string;
	sourceId: string;
};

export type HistoricalImportItem = {
	collection: HistoricalCollection;
	archiveRowId: string;
	archiveParentId: string;
	parentKind: "task" | "workspace";
	ledger: HistoricalLedgerTuple;
	semanticPayload: PortableJson;
	semanticDigest: string;
};

export type HistoricalTargetParents = {
	tasks: ReadonlyMap<string, string>;
	workspaces: ReadonlyMap<string, string>;
};

export class HistoricalImportPlanError extends Error {
	constructor(
		readonly code:
			| "invalid-graph"
			| "invalid-mappings"
			| "historical-author-name-too-long"
			| "planning-cancelled"
			| "planning-timeout",
	) {
		super(code);
		this.name = "HistoricalImportPlanError";
	}
}

const canonicalUuid = (id: string) => id.toLowerCase();

function normalizedAuthor(
	author: PortableAuthorV2,
	document: PortableExportV2,
	principals: ReadonlyMap<string, string>,
): PortableAuthorV2 {
	if (author.kind === "unknown") return { kind: "unknown" };
	if (author.kind === "source_claim") {
		if (author.displayName !== null && author.displayName.length > 512)
			throw new HistoricalImportPlanError("historical-author-name-too-long");
		return {
			...author,
			sourceNamespace: canonicalUuid(author.sourceNamespace),
		};
	}
	const name = principals.get(author.principalId);
	if (name === undefined) throw new HistoricalImportPlanError("invalid-graph");
	if (name.length > 512)
		throw new HistoricalImportPlanError("historical-author-name-too-long");
	return {
		kind: "source_claim",
		sourceNamespace: canonicalUuid(document.sourceNamespace),
		sourcePrincipalId: author.principalId,
		displayName: name,
	};
}

function normalizedOrigin(origin: PortableOriginV2): PortableOriginV2 {
	if (origin.kind === "native")
		return { kind: "source_claim", mechanism: origin.mechanism, label: null };
	return { ...origin };
}

function normalizedRef(
	ref: PortableSourceRef<HistoricalCollection>,
): PortableSourceRef<HistoricalCollection> {
	return { ...ref, namespace: canonicalUuid(ref.namespace) };
}

async function settled<T>(pending: Promise<T>[]): Promise<T[]> {
	const results = await Promise.allSettled(pending);
	return results.map((result) => {
		if (result.status === "rejected") throw result.reason;
		return result.value;
	});
}

async function rawSourceIdHash(id: string, checkpoint: () => void) {
	checkpoint();
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(id),
	);
	checkpoint();
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

// The caller must parse the archive and authorize each resolved parent in the store.
export async function buildHistoricalImportPlan(
	document: PortableExportV2,
	parents: HistoricalTargetParents,
	options: { signal?: AbortSignal; deadline?: number } = {},
): Promise<HistoricalImportItem[]> {
	const deadline = options.deadline ?? performance.now() + 15_000;
	const checkpoint = () => {
		if (options.signal?.aborted)
			throw new HistoricalImportPlanError("planning-cancelled");
		if (performance.now() >= deadline)
			throw new HistoricalImportPlanError("planning-timeout");
	};
	checkpoint();
	if (!validateImportGraphV2(document, checkpoint).valid)
		throw new HistoricalImportPlanError("invalid-graph");
	const principals = new Map(
		document.data.principals.map((p) => [p.id, p.name]),
	);
	const entries: {
		collection: HistoricalCollection;
		row: PortableRowsV2[HistoricalCollection];
	}[] = ["comments", "templates", "completionEvents"].flatMap((collection) =>
		document.data[collection as HistoricalCollection].map((row) => ({
			collection: collection as HistoricalCollection,
			row,
		})),
	);
	const prepared = entries.map(({ collection, row }) => {
		checkpoint();
		const parentKind: "workspace" | "task" =
			collection === "templates" ? "workspace" : "task";
		const archiveParentId = "taskId" in row ? row.taskId : row.workspaceId;
		const map = parentKind === "task" ? parents.tasks : parents.workspaces;
		const targetParentId = map.get(archiveParentId);
		if (!targetParentId)
			throw new HistoricalImportPlanError("invalid-mappings");
		const sourceRef = normalizedRef(row.sourceRef);
		const base = {
			collection,
			targetParentId,
			sourceRef,
		};
		let semanticPayload: PortableJson;
		if (collection === "comments") {
			const comment = row as PortableRowsV2["comments"];
			semanticPayload = {
				...base,
				body: comment.body,
				createdAt: comment.createdAt,
				editedAt: comment.editedAt,
				author: normalizedAuthor(comment.author, document, principals),
			};
		} else if (collection === "templates") {
			const template = row as PortableRowsV2["templates"];
			semanticPayload = {
				...base,
				kind: template.kind,
				name: template.name,
				icon: template.icon,
				content: structuredClone(template.content),
				creator: normalizedAuthor(template.creator, document, principals),
			};
		} else {
			const event = row as PortableRowsV2["completionEvents"];
			const {
				id: _id,
				sourceRef: _ref,
				taskId: _task,
				actor,
				origin,
				...action
			} = event;
			semanticPayload = {
				...base,
				...action,
				actor: normalizedAuthor(actor, document, principals),
				origin: normalizedOrigin(origin),
			};
		}
		return {
			collection,
			archiveRowId: row.id,
			archiveParentId,
			parentKind,
			targetParentId: base.targetParentId,
			sourceRef,
			semanticPayload,
		};
	});
	prepared.sort((a, b) => {
		checkpoint();
		const left = JSON.stringify([
			a.collection,
			a.targetParentId,
			a.sourceRef.namespace,
			a.sourceRef.id,
		]);
		const right = JSON.stringify([
			b.collection,
			b.targetParentId,
			b.sourceRef.namespace,
			b.sourceRef.id,
		]);
		return left < right ? -1 : left > right ? 1 : 0;
	});
	const items: HistoricalImportItem[] = [];
	const seen = new Set<string>();
	for (let offset = 0; offset < prepared.length; offset += 256) {
		checkpoint();
		const batch = await settled(
			prepared.slice(offset, offset + 256).map(async (entry) => {
				const [sourceIdHash, semanticDigest] = await settled([
					rawSourceIdHash(entry.sourceRef.id, checkpoint),
					hashImportValue(
						`ditero-import-historical-${entry.collection}-v5`,
						entry.semanticPayload,
						checkpoint,
					),
				]);
				return {
					collection: entry.collection,
					archiveRowId: entry.archiveRowId,
					archiveParentId: entry.archiveParentId,
					parentKind: entry.parentKind,
					ledger: {
						collection: entry.collection,
						targetParentId: entry.targetParentId,
						sourceNamespace: entry.sourceRef.namespace,
						sourceIdHash,
						sourceId: entry.sourceRef.id,
					},
					semanticPayload: entry.semanticPayload,
					semanticDigest,
				} satisfies HistoricalImportItem;
			}),
		);
		for (const item of batch) {
			const tuple = JSON.stringify([
				item.ledger.collection,
				item.ledger.targetParentId,
				item.ledger.sourceNamespace,
				item.ledger.sourceId,
			]);
			if (seen.has(tuple))
				throw new HistoricalImportPlanError("invalid-mappings");
			seen.add(tuple);
			items.push(item);
		}
	}
	checkpoint();
	return items;
}
