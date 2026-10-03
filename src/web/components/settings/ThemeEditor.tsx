import {
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { randomId } from "../../../domain/random-id.ts";
import {
	type ThemeDocument,
	type ThemeToken,
	validateThemeDocument,
} from "../../../domain/theme-document.ts";
import { m } from "../../../paraglide/messages.js";
import { useDisplayPreferences } from "../../lib/DisplayPreferencesProvider.tsx";
import { saveEditedTheme } from "../../lib/theme-editor.ts";

export function ThemeEditor({
	initial,
	sourceId,
	onClose,
}: {
	initial: ThemeDocument;
	sourceId: string;
	onClose: () => void;
}) {
	const { themeLibrary, setThemeLibrary, setThemePreview, appearanceAccepted } =
		useDisplayPreferences();
	const [draft, setDraft] = useState(() => structuredClone(initial));
	const [saveFailed, setSaveFailed] = useState(false);
	const [saving, setSaving] = useState(false);
	const active = useRef(true);
	const currentDraft = useRef(draft);
	currentDraft.current = draft;
	const nameInput = useRef<HTMLInputElement>(null);
	const id = useId();
	const valid = useMemo(() => {
		try {
			return validateThemeDocument(draft);
		} catch {
			return null;
		}
	}, [draft]);
	useLayoutEffect(() => {
		if (valid) setThemePreview(valid);
	}, [valid, setThemePreview]);
	useLayoutEffect(() => () => setThemePreview(null), [setThemePreview]);
	useEffect(() => {
		active.current = true;
		nameInput.current?.focus();
		return () => {
			active.current = false;
		};
	}, []);

	const labels: Record<ThemeToken, string> = {
		background: m.theme_token_background(),
		foreground: m.theme_token_foreground(),
		card: m.theme_token_card(),
		"card-foreground": m.theme_token_card_foreground(),
		popover: m.theme_token_popover(),
		"popover-foreground": m.theme_token_popover_foreground(),
		primary: m.theme_token_primary(),
		"primary-foreground": m.theme_token_primary_foreground(),
		secondary: m.theme_token_secondary(),
		"secondary-foreground": m.theme_token_secondary_foreground(),
		muted: m.theme_token_muted(),
		"muted-foreground": m.theme_token_muted_foreground(),
		accent: m.theme_token_accent(),
		"accent-foreground": m.theme_token_accent_foreground(),
		border: m.theme_token_border(),
		input: m.theme_token_input(),
		"control-border": m.theme_token_control_border(),
		ring: m.theme_token_ring(),
		sidebar: m.theme_token_sidebar(),
		"sidebar-foreground": m.theme_token_sidebar_foreground(),
		"sidebar-accent": m.theme_token_sidebar_accent(),
		"sidebar-accent-foreground": m.theme_token_sidebar_accent_foreground(),
		"sidebar-border": m.theme_token_sidebar_border(),
	};
	const groups: { label: string; tokens: ThemeToken[] }[] = [
		{
			label: m.theme_editor_group_page(),
			tokens: [
				"background",
				"foreground",
				"card",
				"card-foreground",
				"popover",
				"popover-foreground",
			],
		},
		{
			label: m.theme_editor_group_controls(),
			tokens: [
				"primary",
				"primary-foreground",
				"ring",
				"border",
				"input",
				"control-border",
			],
		},
		{
			label: m.theme_editor_group_surfaces(),
			tokens: [
				"secondary",
				"secondary-foreground",
				"muted",
				"muted-foreground",
				"accent",
				"accent-foreground",
			],
		},
		{
			label: m.theme_editor_group_sidebar(),
			tokens: [
				"sidebar",
				"sidebar-foreground",
				"sidebar-accent",
				"sidebar-accent-foreground",
				"sidebar-border",
			],
		},
	];
	function changeColor(
		mode: "light" | "dark",
		token: ThemeToken,
		color: string,
	) {
		setDraft((current) => ({
			...current,
			[mode]: { ...current[mode], [token]: color },
		}));
		setSaveFailed(false);
	}
	return (
		<form
			data-testid="theme-editor"
			aria-labelledby={`${id}-heading`}
			aria-describedby={`${id}-note`}
			className="flex flex-col gap-4 rounded-lg border p-3"
			onSubmit={async (event) => {
				event.preventDefault();
				if (!valid || saving) return;
				const submitted = draft;
				setSaving(true);
				try {
					const next = saveEditedTheme(
						themeLibrary,
						sourceId,
						valid,
						randomId(),
					);
					if (!(await setThemeLibrary(next))) {
						if (active.current) setSaveFailed(true);
						return;
					}
					if (!active.current || currentDraft.current !== submitted) return;
					setThemePreview(null);
					onClose();
				} catch {
					if (active.current) setSaveFailed(true);
				} finally {
					if (active.current) setSaving(false);
				}
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.stopPropagation();
					setThemePreview(null);
					onClose();
				}
			}}
		>
			<h3 id={`${id}-heading`} className="font-medium">
				{m.theme_editor_heading()}
			</h3>
			<p id={`${id}-note`} className="text-muted-foreground">
				{m.theme_editor_preview_note()}
			</p>
			<label htmlFor={`${id}-name`}>{m.field_name()}</label>
			<Input
				ref={nameInput}
				id={`${id}-name`}
				data-testid="theme-editor-name"
				maxLength={64}
				value={draft.name}
				onChange={(event) => {
					setDraft({ ...draft, name: event.target.value });
					setSaveFailed(false);
				}}
			/>
			{groups.map((group, index) => (
				<details
					key={group.label}
					open={index === 0}
					className="rounded-md border p-3"
				>
					<summary className="min-h-8 cursor-pointer font-medium">
						{group.label}
					</summary>
					<div className="mt-3 flex flex-col gap-4">
						{group.tokens.map((token) => (
							<fieldset key={token} className="min-w-0">
								<legend className="mb-2">{labels[token]}</legend>
								<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
									{(["light", "dark"] as const).map((mode) => {
										const modeLabel =
											mode === "light" ? m.theme_light() : m.theme_dark();
										const fieldId = `${id}-${mode}-${token}`;
										return (
											<div key={mode} className="min-w-0">
												<label
													htmlFor={fieldId}
													className="text-muted-foreground"
												>
													{modeLabel}
												</label>
												<div className="mt-1 flex items-center gap-2">
													<input
														type="color"
														aria-label={m.theme_editor_picker_label({
															color: labels[token],
															mode: modeLabel,
														})}
														className="h-11 w-11 shrink-0 cursor-pointer rounded border bg-background p-1"
														value={
															/^#[0-9a-fA-F]{6}$/.test(draft[mode][token])
																? draft[mode][token]
																: initial[mode][token]
														}
														onChange={(event) =>
															changeColor(mode, token, event.target.value)
														}
													/>
													<Input
														id={fieldId}
														data-testid={`theme-editor-${mode}-${token}`}
														dir="ltr"
														value={draft[mode][token]}
														maxLength={7}
														spellCheck={false}
														autoComplete="off"
														aria-invalid={
															!/^#[0-9a-fA-F]{6}$/.test(draft[mode][token])
														}
														className="h-11 font-mono"
														onChange={(event) =>
															changeColor(mode, token, event.target.value)
														}
													/>
												</div>
											</div>
										);
									})}
								</div>
							</fieldset>
						))}
					</div>
				</details>
			))}
			{!valid && (
				<p role="status" id={`${id}-invalid`}>
					{m.theme_editor_invalid()}
				</p>
			)}
			{saving && (
				<p role="status">
					{appearanceAccepted ? m.appearance_waiting() : m.appearance_saving()}
				</p>
			)}
			{saveFailed && <p role="alert">{m.appearance_save_failed()}</p>}
			<div className="flex flex-wrap gap-2">
				<Button
					type="submit"
					data-testid="theme-editor-save"
					disabled={!valid || saving}
					aria-describedby={!valid ? `${id}-invalid` : undefined}
				>
					{m.theme_editor_save()}
				</Button>
				<Button
					type="button"
					variant="outline"
					data-testid="theme-editor-cancel"
					onClick={() => {
						setThemePreview(null);
						onClose();
					}}
				>
					{m.confirm_cancel()}
				</Button>
			</div>
		</form>
	);
}
