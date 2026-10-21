import { ExternalLink } from "lucide-react";
import { useState } from "react";
import type { NativeSettingsSection } from "../../../domain/native-settings.ts";
import { m } from "../../../paraglide/messages.js";
import { useNativeAccount } from "../../lib/native-account.tsx";
import { Button } from "../ui/button.tsx";

export function NativeBrowserSettings({
	section,
	note,
}: {
	section: NativeSettingsSection;
	note?: string;
}) {
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const native = useNativeAccount();
	if (!native) return null;
	return (
		<div
			className="flex flex-col items-start gap-3"
			data-testid="native-browser-settings"
		>
			<p className="text-sm text-muted-foreground">
				{note ?? m.native_settings_browser_note()}
			</p>
			<Button
				variant="outline"
				className="min-h-11"
				data-native-settings={section}
				disabled={busy}
				onClick={() => {
					setBusy(true);
					setFailed(false);
					void native
						.openSettings(section)
						.catch(() => setFailed(true))
						.finally(() => setBusy(false));
				}}
			>
				<ExternalLink aria-hidden="true" />
				{m.native_settings_open_browser()}
			</Button>
			{failed && (
				<p role="alert" className="text-sm text-destructive">
					{m.native_settings_browser_failed()}
				</p>
			)}
		</div>
	);
}
