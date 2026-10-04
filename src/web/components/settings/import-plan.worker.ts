import { validateImportGraph } from "../../../domain/portability/graph.ts";
import { validateImportGraphV2 } from "../../../domain/portability/graph-v2.ts";
import {
	parseImportDocument,
	UnsupportedImportVersionError,
} from "../../../domain/portability/import-document.ts";
import { ProviderImportError } from "../../../domain/portability/providers/common.ts";
import { parseTaskCsv } from "../../../domain/portability/providers/csv.ts";
import {
	CSV_V1_EXCLUSIONS,
	PROVIDER_INPUT_MAX_BYTES,
	ProviderInputError,
	parseProviderInput,
} from "../../../domain/portability/providers/input.ts";
import { PortableExportValidationError } from "../../../domain/portability/validate.ts";

self.onmessage = async (
	event: MessageEvent<File | { file: File; format: "native" | "csv" }>,
) => {
	try {
		const file = event.data instanceof File ? event.data : event.data.file;
		const format = event.data instanceof File ? "native" : event.data.format;
		if (format === "csv") {
			if (file.size > PROVIDER_INPUT_MAX_BYTES)
				throw new ProviderInputError("byte-limit");
			const bytes = new Uint8Array(await file.arrayBuffer());
			const deadline = performance.now() + 15_000;
			const conversion = parseTaskCsv(bytes, {
				exportedAt: new Date().toISOString(),
				deadline,
			});
			const chunks: string[] = [];
			for (let offset = 0; offset < bytes.length; offset += 24_576) {
				if (performance.now() >= deadline)
					throw new ProviderImportError("timeout");
				chunks.push(
					btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24_576))),
				);
			}
			const input = parseProviderInput(
				{
					kind: "provider",
					version: 1,
					adapter: conversion.adapter,
					adapterVersion: conversion.adapterVersion,
					sourceNamespace: conversion.sourceNamespace,
					identityMode: conversion.identityMode,
					exclusions: [...CSV_V1_EXCLUSIONS],
					originalCsvBase64: chunks.join(""),
				},
				{ deadline },
			);
			self.postMessage({ input, document: conversion.document });
			return;
		}
		if (file.size > 32 * 1024 * 1024)
			throw new PortableExportValidationError("byte-limit");
		const text = await file.text();
		const document = parseImportDocument(text, { historyPreview: true });
		const graph =
			document.schemaVersion === 2
				? validateImportGraphV2(document)
				: validateImportGraph(document);
		if (!graph.valid) throw new Error("invalid");
		if (
			document.data.workspaces.length > 50 ||
			document.data.principals.length > 100
		) {
			self.postMessage({ error: "limit" });
			return;
		}
		self.postMessage({ text, document });
	} catch (error) {
		self.postMessage({
			error:
				error instanceof UnsupportedImportVersionError
					? "unsupported"
					: (error instanceof PortableExportValidationError ||
								error instanceof ProviderImportError ||
								error instanceof ProviderInputError) &&
							error.code.endsWith("-limit")
						? "limit"
						: "invalid",
		});
	}
};
