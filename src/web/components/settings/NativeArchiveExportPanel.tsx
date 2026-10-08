import { useRef, useState } from "react";
import { m } from "../../../paraglide/messages.js";
import { useKeyring } from "../../lib/e2e/KeyringProvider.tsx";
import { supportsAttachmentArchiveExport } from "../../lib/e2e/runtime.ts";
import { Button } from "../ui/button.tsx";
import { AttachmentArchiveExportDialog } from "./AttachmentArchiveExportDialog.tsx";
import { NativeBrowserSettings } from "./NativeBrowserSettings.tsx";

export function NativeArchiveExportPanel() {
	const { runtime } = useKeyring();
	const [archiveOpen, setArchiveOpen] = useState(false);
	const archiveButton = useRef<HTMLButtonElement | null>(null);
	if (!supportsAttachmentArchiveExport(runtime)) {
		return <NativeBrowserSettings />;
	}
	return (
		<div className="flex flex-col gap-8">
			<div className="flex flex-col items-start gap-3">
				<p className="text-sm text-muted-foreground">
					{m.archive_export_description()}
				</p>
				<Button
					ref={archiveButton}
					variant="outline"
					className="h-auto min-h-11 max-w-full whitespace-normal py-2"
					onClick={() => setArchiveOpen(true)}
				>
					{m.archive_export_action()}
				</Button>
			</div>
			<NativeBrowserSettings
				note={m.native_settings_other_data_browser_note()}
			/>
			{archiveOpen && (
				<AttachmentArchiveExportDialog
					onClose={() => {
						setArchiveOpen(false);
						requestAnimationFrame(() => archiveButton.current?.focus());
					}}
				/>
			)}
		</div>
	);
}
