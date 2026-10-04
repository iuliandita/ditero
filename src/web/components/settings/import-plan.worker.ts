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
	TODOIST_V1_EXCLUSIONS,
} from "../../../domain/portability/providers/input.ts";
import { parseTodoistProjectCsv } from "../../../domain/portability/providers/todoist.ts";
import { PortableExportValidationError } from "../../../domain/portability/validate.ts";

self.onmessage = async (
	event: MessageEvent<
		| File
		| {
				file: File;
				format: "native" | "csv" | "todoist";
				projectFolderName?: string;
				unsectionedListName?: string;
		  }
	>,
) => {
	try {
		const file = event.data instanceof File ? event.data : event.data.file;
		const format = event.data instanceof File ? "native" : event.data.format;
		if (format === "csv" || format === "todoist") {
			if (file.size > PROVIDER_INPUT_MAX_BYTES)
				throw new ProviderInputError("byte-limit");
			const deadline = performance.now() + 15_000;
			const bytes = new Uint8Array(await file.arrayBuffer());
			const options = { exportedAt: new Date().toISOString(), deadline };
			const conversion =
				format === "csv"
					? parseTaskCsv(bytes, options)
					: await parseTodoistProjectCsv(bytes, {
							...options,
							projectFolderName:
								event.data instanceof File
									? ""
									: (event.data.projectFolderName ?? ""),
							unsectionedListName:
								event.data instanceof File
									? ""
									: (event.data.unsectionedListName ?? ""),
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
					...(conversion.adapter === "todoist-project-csv"
						? {
								snapshotSha256: conversion.snapshotSha256,
								projectFolderName: conversion.projectFolderName,
								unsectionedListName: conversion.unsectionedListName,
								exclusions: [...TODOIST_V1_EXCLUSIONS],
							}
						: { exclusions: [...CSV_V1_EXCLUSIONS] }),
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
					: error instanceof ProviderImportError &&
							error.code === "secure-context-required"
						? "secure"
						: (error instanceof PortableExportValidationError ||
									error instanceof ProviderImportError ||
									error instanceof ProviderInputError) &&
								error.code.endsWith("-limit")
							? "limit"
							: "invalid",
		});
	}
};
