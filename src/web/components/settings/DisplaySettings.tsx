import { useId } from "react";
import { Button } from "@/components/ui/button";
import { m } from "../../../paraglide/messages.js";
import { ACCENT_PALETTES } from "../../lib/accent-palettes.ts";
import { useDisplayPreferences } from "../../lib/DisplayPreferencesProvider.tsx";
import { NamedThemeSettings } from "./NamedThemeSettings.tsx";

export function DisplaySettings() {
	const {
		preferences,
		setPreferences,
		saveFailed,
		themeLibrary,
		themePreviewActive,
		appearanceLoading,
		appearancePending,
		appearanceAccepted,
		appearanceSaveFailed,
		appearanceCacheFailed,
		retryAppearance,
	} = useDisplayPreferences();
	const id = useId();
	const presets = [
		{ value: "standard", label: m.display_size_standard() },
		{ value: "comfortable", label: m.display_size_comfortable() },
		{ value: "large", label: m.display_size_large() },
	] as const;

	const accents = [
		{ value: "teal", label: m.accent_theme_teal() },
		{ value: "blue", label: m.accent_theme_blue() },
		{ value: "clay", label: m.accent_theme_clay() },
		{ value: "violet", label: m.accent_theme_violet() },
		{ value: "berry", label: m.accent_theme_berry() },
		{ value: "ochre", label: m.accent_theme_ochre() },
	] as const;

	return (
		<div className="flex flex-col gap-4 text-sm" data-testid="display-settings">
			<NamedThemeSettings />
			{appearanceLoading && <p role="status">{m.app_loading()}</p>}
			{appearancePending && (
				<p role="status">
					{appearanceAccepted ? m.appearance_waiting() : m.appearance_saving()}
				</p>
			)}
			{appearanceSaveFailed && (
				<div>
					<p role="alert">{m.appearance_save_failed()}</p>
					<Button
						type="button"
						variant="outline"
						disabled={appearancePending}
						onClick={retryAppearance}
					>
						{m.action_retry()}
					</Button>
				</div>
			)}
			{appearanceCacheFailed && (
				<p role="status">{m.appearance_cache_failed()}</p>
			)}
			<fieldset aria-describedby={`${id}-description`}>
				<legend className="font-medium">{m.display_size_label()}</legend>
				<p id={`${id}-description`} className="mt-1 text-muted-foreground">
					{m.display_size_description()}
				</p>
				<div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
					{presets.map((preset) => (
						<label
							key={preset.value}
							className="flex min-h-11 cursor-pointer items-center gap-2"
						>
							<input
								type="radio"
								name={`${id}-size`}
								value={preset.value}
								checked={preferences.readingSize === preset.value}
								data-testid={`display-size-${preset.value}`}
								className="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
								onChange={() => setPreferences({ readingSize: preset.value })}
							/>
							{preset.label}
						</label>
					))}
				</div>
			</fieldset>
			<div className="flex items-center justify-between gap-4">
				<div>
					<p id={`${id}-contrast`} className="font-medium">
						{m.display_contrast_label()}
					</p>
					<p
						id={`${id}-contrast-description`}
						className="mt-1 text-muted-foreground"
					>
						{m.display_contrast_description()}
					</p>
				</div>
				<Button
					type="button"
					variant={preferences.highContrast ? "default" : "outline"}
					role="switch"
					aria-checked={preferences.highContrast}
					aria-labelledby={`${id}-contrast`}
					aria-describedby={`${id}-contrast-description`}
					data-testid="display-high-contrast"
					className="min-h-11 min-w-16"
					onClick={() =>
						setPreferences({ highContrast: !preferences.highContrast })
					}
				>
					{preferences.highContrast ? m.toggle_on() : m.toggle_off()}
				</Button>
			</div>
			<fieldset aria-describedby={`${id}-accent-description`}>
				<legend className="font-medium">{m.accent_theme_label()}</legend>
				<p
					id={`${id}-accent-description`}
					className="mt-1 text-muted-foreground"
				>
					{m.accent_theme_description()}
				</p>
				{themePreviewActive && (
					<p className="mt-1 text-muted-foreground">
						{m.theme_editor_accent_note()}
					</p>
				)}
				<div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
					{accents.map((accent) => (
						<label
							key={accent.value}
							className="flex min-h-11 cursor-pointer items-center gap-2"
						>
							<input
								type="radio"
								name={`${id}-accent`}
								value={accent.value}
								disabled={themePreviewActive || appearanceLoading}
								checked={
									themeLibrary.useAccent &&
									preferences.accentTheme === accent.value
								}
								data-testid={`display-accent-${accent.value}`}
								className="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
								onChange={() => setPreferences({ accentTheme: accent.value })}
							/>
							<span
								aria-hidden="true"
								className="size-5 shrink-0 rounded-full border border-foreground/20"
								style={{ backgroundColor: ACCENT_PALETTES[accent.value].main }}
							/>
							{accent.label}
						</label>
					))}
				</div>
			</fieldset>
			<p className="text-muted-foreground">{m.display_device_note()}</p>
			{saveFailed && (
				<p role="status" className="text-foreground">
					{m.display_save_failed()}
				</p>
			)}
		</div>
	);
}
