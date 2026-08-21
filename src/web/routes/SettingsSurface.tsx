import type { Role } from "../../domain/role.ts";
import { m } from "../../paraglide/messages.js";
import { KarmaPanel } from "../components/karma/KarmaPanel.tsx";
import { FocusSettings } from "../components/settings/FocusSettings.tsx";
import { KarmaSettings } from "../components/settings/KarmaSettings.tsx";
import { KeymapSettings } from "../components/settings/KeymapSettings.tsx";
import { LabelManager } from "../components/settings/LabelManager.tsx";
import { LanguageSwitcher } from "../components/settings/LanguageSwitcher.tsx";
import { NotificationSettings } from "../components/settings/NotificationSettings.tsx";
import { TemplateManager } from "../components/settings/TemplateManager.tsx";
import { ThemeSwitcher } from "../components/settings/ThemeSwitcher.tsx";
import { BackButton } from "../components/ui/back-button.tsx";
import type { Locale } from "../lib/locale.ts";
import { SecurityPanel } from "./SecurityPanel.tsx";

export function SettingsSurface({
	activeId,
	activeRole,
	isDesktop,
	persistLocale,
	onBack,
	onOpenList,
}: {
	activeId: string | null;
	activeRole: Role | null;
	isDesktop: boolean;
	persistLocale: (locale: Locale) => void;
	onBack: () => void;
	onOpenList: (id: string) => void;
}) {
	return (
		<div data-testid="settings-surface">
			<div className="flex items-center gap-2 border-b p-3">
				<BackButton data-testid="settings-back" onClick={onBack} />
				<h1 className="truncate text-lg font-semibold">{m.nav_settings()}</h1>
			</div>
			<div className="p-4 md:p-6">
				<SecurityPanel />
				<KarmaPanel />
				<KarmaSettings />
				<LanguageSwitcher persistLocale={persistLocale} />
				<ThemeSwitcher />
				{/* Keyboard is a desktop feature (design 2.18). */}
				{isDesktop && <KeymapSettings />}
				{activeId && <LabelManager workspaceId={activeId} role={activeRole} />}
				{activeId && (
					<TemplateManager
						workspaceId={activeId}
						role={activeRole}
						onUsed={onOpenList}
					/>
				)}
				<FocusSettings />
				<NotificationSettings />
			</div>
		</div>
	);
}
