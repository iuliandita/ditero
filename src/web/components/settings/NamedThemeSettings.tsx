import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { randomId } from "../../../domain/random-id.ts";
import {
	BUILTIN_THEME_DOCUMENTS,
	parseThemeDocument,
	serializeThemeDocument,
	THEME_DOCUMENT_MAX_BYTES,
	type ThemeDocument,
} from "../../../domain/theme-document.ts";
import { m } from "../../../paraglide/messages.js";
import { useDisplayPreferences } from "../../lib/DisplayPreferencesProvider.tsx";
import {
	MAX_CUSTOM_THEMES,
	resolveThemeDocument,
	selectedThemeDocument,
} from "../../lib/theme-documents.ts";
import { ThemeEditor } from "./ThemeEditor.tsx";

export function NamedThemeSettings() {
	const { preferences, themeLibrary, setThemeLibrary } =
		useDisplayPreferences();
	const id = useId();
	const input = useRef<HTMLInputElement>(null);
	const [failed, setFailed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [editing, setEditing] = useState<{
		sourceId: string;
		document: ThemeDocument;
	} | null>(null);
	const editButton = useRef<HTMLButtonElement>(null);
	const active = useRef(true);
	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);
	const selected = selectedThemeDocument(themeLibrary);
	const names = { paper: m.named_theme_paper(), slate: m.named_theme_slate() };
	const isCustom = themeLibrary.documents.some(
		(entry) => entry.id === themeLibrary.selected,
	);
	if (editing)
		return (
			<ThemeEditor
				sourceId={editing.sourceId}
				initial={editing.document}
				onClose={() => {
					setEditing(null);
					requestAnimationFrame(() => editButton.current?.focus());
				}}
			/>
		);
	return (
		<fieldset
			aria-describedby={`${id}-description`}
			className="flex flex-col gap-3"
		>
			<legend className="font-medium">{m.named_theme_label()}</legend>
			<p id={`${id}-description`} className="text-muted-foreground">
				{m.named_theme_local_note()}
			</p>
			<label htmlFor={`${id}-selection`} className="sr-only">
				{m.named_theme_label()}
			</label>
			<select
				id={`${id}-selection`}
				data-testid="named-theme-select"
				className="min-h-11 w-full rounded-md border border-input bg-background px-3 sm:w-56"
				value={themeLibrary.selected}
				disabled={busy}
				onChange={(event) => {
					setFailed(false);
					setThemeLibrary({
						...themeLibrary,
						selected: event.target.value,
						useAccent: !themeLibrary.documents.some(
							(entry) => entry.id === event.target.value,
						),
					});
				}}
			>
				<option value="default">{m.named_theme_default()}</option>
				{Object.keys(BUILTIN_THEME_DOCUMENTS).map((key) => (
					<option key={key} value={key}>
						{names[key as keyof typeof names]}
					</option>
				))}
				{themeLibrary.documents.map((entry) => (
					<option key={entry.id} value={entry.id}>
						{entry.document.name}
					</option>
				))}
			</select>
			<p className="text-muted-foreground">{m.named_theme_accent_note()}</p>
			<div className="flex flex-wrap gap-2">
				<Button
					ref={editButton}
					type="button"
					variant="outline"
					data-testid="named-theme-customize"
					disabled={
						!selected ||
						busy ||
						(!isCustom && themeLibrary.documents.length >= MAX_CUSTOM_THEMES)
					}
					onClick={() => {
						if (selected)
							setEditing({
								sourceId: themeLibrary.selected,
								document: resolveThemeDocument(
									selected,
									preferences.accentTheme,
									themeLibrary.useAccent,
								),
							});
					}}
				>
					{m.theme_editor_customize()}
				</Button>
				<Button
					type="button"
					variant="outline"
					onClick={() => input.current?.click()}
					disabled={busy || themeLibrary.documents.length >= MAX_CUSTOM_THEMES}
				>
					{m.named_theme_import()}
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={!selected || busy}
					onClick={() => {
						if (!selected) return;
						const raw = serializeThemeDocument(
							resolveThemeDocument(
								selected,
								preferences.accentTheme,
								themeLibrary.useAccent,
							),
						);
						const url = URL.createObjectURL(
							new Blob([raw], { type: "application/json" }),
						);
						const link = document.createElement("a");
						link.href = url;
						link.download = "ditero-theme.json";
						link.click();
						setTimeout(() => URL.revokeObjectURL(url), 0);
					}}
				>
					{m.named_theme_export()}
				</Button>
				{themeLibrary.documents.some(
					(entry) => entry.id === themeLibrary.selected,
				) && (
					<Button
						type="button"
						variant="outline"
						disabled={busy}
						onClick={() => {
							setThemeLibrary({
								selected: "default",
								useAccent: true,
								documents: themeLibrary.documents.filter(
									(entry) => entry.id !== themeLibrary.selected,
								),
							});
							setFailed(false);
						}}
					>
						{m.named_theme_remove()}
					</Button>
				)}
			</div>
			<input
				ref={input}
				type="file"
				accept="application/json,.json"
				className="hidden"
				data-testid="named-theme-import"
				onChange={async (event) => {
					const file = event.target.files?.[0];
					event.target.value = "";
					if (!file) return;
					setBusy(true);
					try {
						if (
							file.size > THEME_DOCUMENT_MAX_BYTES ||
							themeLibrary.documents.length >= MAX_CUSTOM_THEMES
						)
							throw new Error("Theme limit exceeded");
						const theme = parseThemeDocument(await file.text());
						if (!active.current) return;
						const themeId = randomId();
						setThemeLibrary({
							selected: themeId,
							useAccent: false,
							documents: [
								...themeLibrary.documents,
								{ id: themeId, document: theme },
							],
						});
						setFailed(false);
					} catch {
						if (active.current) setFailed(true);
					} finally {
						if (active.current) setBusy(false);
					}
				}}
			/>
			{!selected && (
				<p className="text-muted-foreground">{m.named_theme_export_note()}</p>
			)}
			{themeLibrary.documents.length >= MAX_CUSTOM_THEMES && (
				<p className="text-muted-foreground">{m.named_theme_limit()}</p>
			)}
			{failed && <p role="alert">{m.named_theme_invalid()}</p>}
		</fieldset>
	);
}
