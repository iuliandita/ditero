import { useId } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { m } from "../../../paraglide/messages.js";
import { useThemeChoice } from "../../hooks/useThemeChoice.ts";

// A control, not an applier: useSyncedTheme() owns applying the synced choice
// so it also reaches devices whose user never opens this surface (#160).
export function ThemeSwitcher() {
	const { theme, setTheme } = useThemeChoice();
	const labelId = useId();

	return (
		<div className="flex flex-col gap-1 text-sm">
			<span id={labelId} className="text-muted-foreground">
				{m.theme_switcher_label()}
			</span>
			<Select value={theme} onValueChange={setTheme}>
				<SelectTrigger
					aria-labelledby={labelId}
					data-testid="theme-switcher"
					className="w-full sm:w-56"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="system">{m.theme_system()}</SelectItem>
					<SelectItem value="light">{m.theme_light()}</SelectItem>
					<SelectItem value="dark">{m.theme_dark()}</SelectItem>
				</SelectContent>
			</Select>
		</div>
	);
}
