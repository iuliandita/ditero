import { useEffect, useMemo, useRef } from "react";
import type { Role } from "../../domain/role.ts";
import { m } from "../../paraglide/messages.js";
import { KarmaPanel } from "../components/karma/KarmaPanel.tsx";
import { AccountDeletionPanel } from "../components/settings/AccountDeletionPanel.tsx";
import { AccountPanel } from "../components/settings/AccountPanel.tsx";
import { DataPortabilityPanel } from "../components/settings/DataPortabilityPanel.tsx";
import { FocusSettings } from "../components/settings/FocusSettings.tsx";
import { ImportPlanPanel } from "../components/settings/ImportPlanPanel.tsx";
import { KarmaSettings } from "../components/settings/KarmaSettings.tsx";
import { KeymapSettings } from "../components/settings/KeymapSettings.tsx";
import { LabelManager } from "../components/settings/LabelManager.tsx";
import { LanguageSwitcher } from "../components/settings/LanguageSwitcher.tsx";
import { NotificationSettings } from "../components/settings/NotificationSettings.tsx";
import {
	SettingsNav,
	type SettingsNavItem,
} from "../components/settings/SettingsNav.tsx";
import { SettingsSection } from "../components/settings/SettingsSection.tsx";
import { TemplateManager } from "../components/settings/TemplateManager.tsx";
import { ThemeSwitcher } from "../components/settings/ThemeSwitcher.tsx";
import { TimeZoneSetting } from "../components/settings/TimeZoneSetting.tsx";
import { SyncIndicator } from "../components/shell/SyncIndicator.tsx";
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
	autoFocusBack,
}: {
	activeId: string | null;
	activeRole: Role | null;
	isDesktop: boolean;
	persistLocale: (locale: Locale) => void;
	onBack: () => void;
	onOpenList: (id: string) => void;
	// Phones arrive from a sheet that unmounts with its trigger; without a
	// deliberate target focus would fall to the document body.
	autoFocusBack?: boolean;
}) {
	const backRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (autoFocusBack) backRef.current?.focus();
	}, [autoFocusBack]);
	// Order is the reading order: who you are, how it looks, what reaches you,
	// how the account is protected, then the everyday tools, then your data,
	// and the irreversible action alone at the end.
	const nav = useMemo(() => {
		const items: SettingsNavItem[] = [
			{ id: "account", label: m.settings_section_account() },
			{ id: "appearance", label: m.settings_section_appearance() },
			{ id: "notifications", label: m.notifications_heading() },
			{ id: "security", label: m.security_heading() },
		];
		if (activeId)
			items.push({ id: "lists", label: m.settings_section_lists() });
		items.push({ id: "focus", label: m.settings_section_focus() });
		// Keyboard is a desktop feature (design 2.18).
		if (isDesktop) items.push({ id: "keyboard", label: m.keymap_heading() });
		items.push(
			{ id: "data", label: m.settings_section_data() },
			{ id: "danger", label: m.settings_section_danger() },
		);
		return items;
	}, [activeId, isDesktop]);

	return (
		<div data-testid="settings-surface">
			<div className="flex items-center gap-2 border-b p-3">
				<BackButton
					ref={backRef}
					data-testid="settings-back"
					onClick={onBack}
				/>
				<h1 className="truncate text-lg font-semibold">{m.nav_settings()}</h1>
				{!isDesktop && (
					<div className="ms-auto">
						<SyncIndicator placement="header" />
					</div>
				)}
			</div>
			<div className="px-4 py-6 md:px-6 xl:grid xl:grid-cols-[11rem_minmax(0,42rem)] xl:gap-12">
				<SettingsNav items={nav} />
				<div className="min-w-0 max-w-2xl [&_[data-section]]:scroll-mt-20 xl:[&_[data-section]]:scroll-mt-4">
					<SettingsSection id="account" title={m.settings_section_account()}>
						<AccountPanel />
					</SettingsSection>

					<SettingsSection
						id="appearance"
						title={m.settings_section_appearance()}
					>
						<div className="flex flex-col gap-5">
							<LanguageSwitcher persistLocale={persistLocale} />
							<ThemeSwitcher />
							<TimeZoneSetting />
						</div>
					</SettingsSection>

					<SettingsSection id="notifications" title={m.notifications_heading()}>
						<NotificationSettings />
					</SettingsSection>

					<SettingsSection id="security" title={m.security_heading()}>
						<SecurityPanel />
					</SettingsSection>

					{activeId && (
						<SettingsSection id="lists" title={m.settings_section_lists()}>
							<LabelManager workspaceId={activeId} role={activeRole} />
							<TemplateManager
								workspaceId={activeId}
								role={activeRole}
								onUsed={onOpenList}
							/>
						</SettingsSection>
					)}

					<SettingsSection id="focus" title={m.settings_section_focus()}>
						<FocusSettings />
						<KarmaPanel />
						<KarmaSettings />
					</SettingsSection>

					{isDesktop && (
						<SettingsSection id="keyboard" title={m.keymap_heading()}>
							<KeymapSettings />
						</SettingsSection>
					)}

					<SettingsSection id="data" title={m.settings_section_data()}>
						<DataPortabilityPanel />
						<ImportPlanPanel />
					</SettingsSection>

					<SettingsSection
						id="danger"
						title={m.settings_section_danger()}
						tone="danger"
					>
						<AccountDeletionPanel />
					</SettingsSection>
				</div>
			</div>
		</div>
	);
}
