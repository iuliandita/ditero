import { ExternalLink } from "lucide-react";
import { m } from "../../../paraglide/messages.js";
import { useNativeAccount } from "../../lib/native-account.tsx";
import { Button } from "../ui/button.tsx";

export function NativeBrowserSettings({ note }: { note?: string }) {
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
			<Button asChild variant="outline" className="min-h-11">
				<a href={`${native.origin}/`}>
					<ExternalLink aria-hidden="true" />
					{m.native_settings_open_browser()}
				</a>
			</Button>
		</div>
	);
}
