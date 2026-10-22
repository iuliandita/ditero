import type { Pool } from "pg";
import type { ProviderImportOptions } from "../../domain/portability/providers/common.ts";
import { CONTENT_ADAPTER } from "../../domain/portability/providers/content-common.ts";
import {
	type ProviderInputBinding,
	parseProviderBinding,
	prepareProviderImportRequest,
} from "../../domain/portability/providers/input.ts";
import {
	type ImportSourceSelection,
	importTransaction,
} from "./import-plan-store.ts";

function withoutAnchor(binding: ProviderInputBinding) {
	if (binding.adapter !== CONTENT_ADAPTER) return binding;
	const { anchorDay: _anchor, notices: _notices, ...settings } = binding;
	return settings;
}

export async function prepareAnchoredProviderImport(
	pool: Pool,
	ownerId: string,
	source: ImportSourceSelection,
	value: unknown,
	options: ProviderImportOptions & { exportedAt: string },
) {
	// Validate the current preview against its bytes before consulting saved metadata.
	const prepared = await prepareProviderImportRequest(value, options);
	if (
		source.mode !== "existing" ||
		prepared.binding.adapter !== CONTENT_ADAPTER ||
		prepared.binding.provider !== "todoist"
	)
		return prepared;
	const stored = await importTransaction(
		pool,
		ownerId,
		async (client) => {
			const result = await client.query<{
				input_binding: ProviderInputBinding | null;
			}>(
				"select input_binding from import_source where id = $1 and owner_user_id = $2",
				[source.id, ownerId],
			);
			return result.rows[0]?.input_binding ?? null;
		},
		options.signal,
		options.deadline,
	);
	const binding = stored ? parseProviderBinding(stored, options) : null;
	if (
		!binding ||
		binding.adapter !== CONTENT_ADAPTER ||
		binding.provider !== "todoist" ||
		!binding.anchorDay ||
		binding.anchorDay === prepared.binding.anchorDay ||
		JSON.stringify(withoutAnchor(binding)) !==
			JSON.stringify(withoutAnchor(prepared.binding))
	)
		return prepared;
	// Reparse with the source's original anchor; the final store still checks its binding.
	return prepareProviderImportRequest(
		{
			...binding,
			originalBase64: (value as { originalBase64: string }).originalBase64,
		},
		options,
	);
}
