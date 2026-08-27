import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { m } from "../../../paraglide/messages.js";
import { useThemeChoice } from "../../hooks/useThemeChoice.ts";
import type { Theme } from "../../lib/theme.ts";

const ICON: Record<Theme, typeof Sun> = {
	system: Monitor,
	light: Sun,
	dark: Moon,
};

// The same three states as the Settings select, one click from the sidebar.
// A radio group rather than a cycling button: three states do not cycle
// discoverably, and M5 adds named themes, which a menu grows into and a toggle
// does not.
export function ThemeMenu({ collapsed }: { collapsed?: boolean }) {
	const { theme, setTheme } = useThemeChoice();
	const Icon = ICON[theme];

	return (
		// modal={false} for the same reason RowActions gives: a modal Radix menu
		// aria-hides the app root while its controls stay tabbable, which axe
		// scores as a serious aria-hidden-focus violation.
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					data-testid="theme-menu"
					aria-label={m.theme_switcher_label()}
				>
					<Icon className="size-4" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align={collapsed ? "start" : "end"}>
				<DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
					<DropdownMenuRadioItem value="system">
						{m.theme_system()}
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="light">
						{m.theme_light()}
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="dark">
						{m.theme_dark()}
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
