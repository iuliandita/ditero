import {
	type ImportGraphContext,
	type ImportGraphResult,
	validateContentGraph,
} from "./graph.ts";
import type {
	PortableAuthorV2,
	PortableExportV2,
	PortableRowsV2,
} from "./v2.ts";

function checkAuthor(
	author: PortableAuthorV2,
	path: string,
	{ principals, requireRef }: ImportGraphContext,
) {
	if (author.kind === "native_user")
		requireRef(principals, author.principalId, `${path}.principalId`);
}

export function validateImportGraphV2(
	source: PortableExportV2,
): ImportGraphResult {
	return validateContentGraph<PortableRowsV2>(source, {
		onIndexed: ({ error }) => {
			const eventIds = new Set<string>();
			const sourceRefs = new Set<string>();
			for (const collection of [
				"comments",
				"templates",
				"completionEvents",
			] as const) {
				source.data[collection].forEach((row, i) => {
					const path = `data.${collection}[${i}]`;
					if (row.sourceRef.collection !== collection)
						error(
							"source-reference-collection-mismatch",
							`${path}.sourceRef.collection`,
						);
					if (collection === "completionEvents") {
						if (eventIds.has(row.id)) error("duplicate-id", `${path}.id`);
						else eventIds.add(row.id);
					}
					const ref = JSON.stringify([
						row.sourceRef.namespace.toLowerCase(),
						row.sourceRef.collection,
						row.sourceRef.id,
					]);
					if (sourceRefs.has(ref))
						error("duplicate-source-reference", `${path}.sourceRef`);
					else sourceRefs.add(ref);
				});
			}
		},
		checkTemplateCreator: (row, path, context) =>
			checkAuthor(row.creator, `${path}.creator`, context),
		checkCommentAuthor: (row, path, context) =>
			checkAuthor(row.author, `${path}.author`, context),
		onComplete: (context) => {
			source.data.completionEvents.forEach((row, i) => {
				const path = `data.completionEvents[${i}]`;
				context.requireRef(context.tasks, row.taskId, `${path}.taskId`);
				checkAuthor(row.actor, `${path}.actor`, context);
			});
		},
	});
}
