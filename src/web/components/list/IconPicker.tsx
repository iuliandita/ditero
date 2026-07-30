import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ICON_NAMES, ICONS, iconLabel } from "@/lib/list-icon";
import { cn } from "@/lib/utils";
import type { ListKind } from "../../../domain/icon-map.ts";
import { suggestIcon } from "../../../domain/icon-map.ts";
import { m } from "../../../paraglide/messages.js";

const EMOJI = [
	"📝",
	"✅",
	"🛒",
	"🏠",
	"💼",
	"🎯",
	"📌",
	"⭐",
	"❤️",
	"🔥",
	"🎁",
	"🎉",
	"🍎",
	"🍕",
	"☕",
	"🍺",
	"🐶",
	"🐱",
	"🌱",
	"🌸",
	"⛺",
	"✈️",
	"🚗",
	"🚲",
	"💊",
	"🩺",
	"🧹",
	"🧺",
	"💡",
	"🔧",
	"📚",
	"🎵",
	"🎮",
	"📷",
	"🏋️",
	"⚽",
	"💰",
	"💳",
	"🔑",
	"🔒",
	"☀️",
	"🌙",
	"☁️",
	"🌧️",
	"🎂",
	"👶",
	"🐟",
	"🐦",
	"🧴",
	"🧼",
];

export function IconPicker({
	open,
	onOpenChange,
	kind,
	title,
	current,
	onSelect,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	kind: ListKind;
	title: string;
	current?: string | null;
	onSelect: (icon: string) => void;
}) {
	const suggested = suggestIcon(title, kind);
	const SuggestedIcon = ICONS[suggested];

	function pick(icon: string) {
		onSelect(icon);
		onOpenChange(false);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{m.icon_picker_title()}</DialogTitle>
				</DialogHeader>

				{SuggestedIcon && (
					<button
						type="button"
						onClick={() => pick(suggested)}
						className="flex items-center gap-2 self-start rounded-lg border px-2.5 py-1.5 text-sm text-muted-foreground hover:text-foreground"
					>
						<SuggestedIcon className="size-4" />
						{m.icon_picker_suggested()}
					</button>
				)}

				<Tabs defaultValue="icons">
					<TabsList>
						<TabsTrigger value="icons">{m.icon_picker_tab_icons()}</TabsTrigger>
						<TabsTrigger value="emoji">{m.icon_picker_tab_emoji()}</TabsTrigger>
					</TabsList>
					<TabsContent value="icons">
						<div className="grid max-h-64 grid-cols-8 gap-1 overflow-y-auto p-0.5">
							{ICON_NAMES.map((name) => {
								const Icon = ICONS[name];
								return (
									<button
										key={name}
										type="button"
										aria-label={iconLabel(name)}
										onClick={() => pick(name)}
										className={cn(
											"flex size-9 items-center justify-center rounded-lg border hover:bg-muted",
											current === name && "border-ring bg-muted",
										)}
									>
										<Icon className="size-4" />
									</button>
								);
							})}
						</div>
					</TabsContent>
					<TabsContent value="emoji">
						<div className="grid max-h-64 grid-cols-8 gap-1 overflow-y-auto p-0.5">
							{/* The emoji character is deliberately its own label: a screen
							    reader announces it by its CLDR short name in the READER's
							    language. A keyed name would override that with the app's
							    locale, which is worse when the two disagree. */}
							{EMOJI.map((emoji) => (
								<button
									key={emoji}
									type="button"
									aria-label={emoji}
									onClick={() => pick(emoji)}
									className={cn(
										"flex size-9 items-center justify-center rounded-lg border text-lg hover:bg-muted",
										current === emoji && "border-ring bg-muted",
									)}
								>
									{emoji}
								</button>
							))}
						</div>
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}
