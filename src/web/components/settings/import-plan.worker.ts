import { validateImportGraph } from "../../../domain/portability/graph.ts";
import {
	parseImportDocument,
	UnsupportedImportVersionError,
} from "../../../domain/portability/import-document.ts";
import { PortableExportValidationError } from "../../../domain/portability/validate.ts";

self.onmessage = async (event: MessageEvent<File>) => {
	try {
		if (event.data.size > 32 * 1024 * 1024)
			throw new PortableExportValidationError("byte-limit");
		const text = await event.data.text();
		const document = parseImportDocument(text);
		if (!validateImportGraph(document).valid) throw new Error("invalid");
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
					: error instanceof PortableExportValidationError &&
							error.code.endsWith("-limit")
						? "limit"
						: "invalid",
		});
	}
};
