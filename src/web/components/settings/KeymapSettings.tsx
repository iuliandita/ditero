import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	type Binding,
	findConflicts,
	resolveKeymap,
} from "../../../domain/keymap.ts";
import { m } from "../../../paraglide/messages.js";
import { useUserPref } from "../../hooks/useUserPref.ts";
import { formatBinding } from "../../keyboard/binding-label.ts";
import { EMPTY_CAPTURE, stepCapture } from "../../keyboard/capture.ts";
import { categoryLabel } from "../../keyboard/category-label.ts";
import { COMMANDS } from "../../keyboard/commands.ts";
import { useEffectiveKeymap } from "../../keyboard/useEffectiveKeymap.ts";

// `c.label` is a locale-dependent getter, so the lookup resolves it per render
// rather than storing what it read at import.
const COMMAND_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

function commandLabel(id: string): string {
	return COMMAND_BY_ID.get(id)?.label ?? id;
}

// Commands grouped by category, preserving registry order (all commands, incl.
// unassigned ones -- unlike the cheat-sheet which hides empties).
const GROUPS = (() => {
	const byCat = new Map<string, typeof COMMANDS>();
	for (const cmd of COMMANDS) {
		const rows = byCat.get(cmd.category) ?? [];
		rows.push(cmd);
		byCat.set(cmd.category, rows);
	}
	return [...byCat.entries()];
})();

const KBD_CLASS = "rounded border bg-muted px-1.5 py-0.5 font-mono text-xs";

type Draft = { commandId: string; binding: Binding };

export function KeymapSettings() {
	const { pref, setPref } = useUserPref();
	const keymap = useEffectiveKeymap();
	const [capturingId, setCapturingId] = useState<string | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const saveRef = useRef<HTMLButtonElement | null>(null);
	const rebindRefs = useRef(new Map<string, HTMLButtonElement | null>());
	const returnFocusId = useRef<string | null>(null);

	// Keyboard focus management for the rebind flow (screen-reader/keyboard users):
	// when a draft appears, move focus to Save (it just replaced the Rebind button
	// they were on); when it clears, return focus to that command's Rebind button.
	useEffect(() => {
		if (draft) {
			saveRef.current?.focus();
			return;
		}
		const id = returnFocusId.current;
		if (id) {
			rebindRefs.current.get(id)?.focus();
			returnFocusId.current = null;
		}
	}, [draft]);

	// While capturing, a capture-phase window listener swallows the keydown
	// (stopPropagation + preventDefault) so the pressed key can't ALSO reach the
	// global bubble-phase handler in useKeyBindings -- pressing `c` to rebind must
	// not run task.create. Esc cancels; a completed binding becomes the draft.
	useEffect(() => {
		if (!capturingId) return;
		const id = capturingId;
		function onKeyDown(e: KeyboardEvent) {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Escape") {
				setCapturingId(null);
				return;
			}
			const { binding } = stepCapture(EMPTY_CAPTURE, {
				key: e.key,
				metaKey: e.metaKey,
				ctrlKey: e.ctrlKey,
			});
			if (binding) {
				setDraft({ commandId: id, binding });
				setCapturingId(null);
			}
		}
		window.addEventListener("keydown", onKeyDown, { capture: true });
		return () =>
			window.removeEventListener("keydown", onKeyDown, { capture: true });
	}, [capturingId]);

	// Preview conflicts for the draft binding against the prospective override set;
	// naming the OTHER command lets the user decide (save is still allowed).
	const conflictLabel = useMemo(() => {
		if (!draft) return null;
		const prospective = { ...pref.keymap, [draft.commandId]: [draft.binding] };
		const km = resolveKeymap(COMMANDS, pref.keymapProfile, prospective);
		for (const [a, b] of findConflicts(km, COMMANDS)) {
			if (a === draft.commandId) return commandLabel(b);
			if (b === draft.commandId) return commandLabel(a);
		}
		return null;
	}, [draft, pref.keymap, pref.keymapProfile]);

	function startCapture(id: string) {
		setDraft(null);
		setCapturingId(id);
	}

	function saveDraft() {
		if (!draft) return;
		returnFocusId.current = draft.commandId;
		setPref({
			keymap: { ...pref.keymap, [draft.commandId]: [draft.binding] },
		});
		setDraft(null);
	}

	function cancelDraft() {
		if (draft) returnFocusId.current = draft.commandId;
		setDraft(null);
		setCapturingId(null);
	}

	function resetCommand(id: string) {
		const { [id]: _removed, ...rest } = pref.keymap;
		setPref({ keymap: rest });
	}

	return (
		<section className="mt-8 border-t pt-4" aria-labelledby="keymap-heading">
			<div className="flex items-center justify-between gap-4">
				<h2 id="keymap-heading" className="text-sm font-semibold">
					{m.keymap_heading()}
				</h2>
				<fieldset className="m-0 inline-flex gap-1 border-0 p-0">
					<legend className="sr-only">{m.keymap_profile_legend()}</legend>
					<Button
						size="sm"
						variant={pref.keymapProfile === "default" ? "default" : "outline"}
						aria-pressed={pref.keymapProfile === "default"}
						data-testid="keymap-profile-default"
						onClick={() => setPref({ keymapProfile: "default" })}
					>
						{m.keymap_profile_default()}
					</Button>
					<Button
						size="sm"
						variant={pref.keymapProfile === "vim" ? "default" : "outline"}
						aria-pressed={pref.keymapProfile === "vim"}
						data-testid="keymap-profile-vim"
						onClick={() => setPref({ keymapProfile: "vim" })}
					>
						{m.keymap_profile_vim()}
					</Button>
				</fieldset>
			</div>

			<div className="mt-4 flex flex-col gap-4">
				{GROUPS.map(([category, rows]) => (
					<div key={category}>
						<h3 className="mb-1 text-xs font-medium text-muted-foreground">
							{categoryLabel(category)}
						</h3>
						<ul className="flex flex-col gap-1">
							{rows.map((cmd) => {
								const capturing = capturingId === cmd.id;
								const drafting = draft?.commandId === cmd.id;
								const bindings = keymap[cmd.id] ?? [];
								const hasOverride = cmd.id in pref.keymap;
								return (
									<li
										key={cmd.id}
										className="flex items-center justify-between gap-4 py-1"
									>
										<span className="text-sm">{cmd.label}</span>
										<div className="flex items-center gap-2">
											{capturing ? (
												<span
													role="status"
													aria-live="polite"
													data-testid="keymap-capture"
													className="flex items-center gap-1.5 text-xs text-muted-foreground"
												>
													<span
														aria-hidden="true"
														className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse"
													/>
													{m.keymap_capture_hint()}
												</span>
											) : drafting && draft ? (
												<>
													{/* Announce the captured binding + any conflict so
													    keyboard/SR users get feedback before they Save. */}
													<span
														role="status"
														aria-live="polite"
														data-testid="keymap-draft"
														className="flex items-center gap-2"
													>
														<kbd className={KBD_CLASS}>
															{formatBinding(draft.binding)}
														</kbd>
														{conflictLabel ? (
															<span className="text-xs text-destructive">
																{m.keymap_conflict({ command: conflictLabel })}
															</span>
														) : null}
													</span>
													<Button
														ref={saveRef}
														size="xs"
														data-testid="keymap-save"
														aria-label={m.keymap_save_label({
															command: cmd.label,
														})}
														onClick={saveDraft}
													>
														{m.keymap_save()}
													</Button>
													<Button
														size="xs"
														variant="ghost"
														data-testid="keymap-cancel"
														aria-label={m.keymap_cancel_label()}
														onClick={cancelDraft}
													>
														{m.keymap_cancel()}
													</Button>
												</>
											) : (
												<>
													{bindings.length ? (
														<span className="flex shrink-0 gap-1">
															{bindings.map((b) => (
																<kbd key={b.join("+")} className={KBD_CLASS}>
																	{formatBinding(b)}
																</kbd>
															))}
														</span>
													) : (
														<span className="text-xs text-muted-foreground">
															{m.keymap_unassigned()}
														</span>
													)}
													<Button
														ref={(el) => {
															rebindRefs.current.set(cmd.id, el);
														}}
														size="xs"
														variant="outline"
														aria-label={m.keymap_rebind_label({
															command: cmd.label,
														})}
														data-testid={`keymap-rebind-${cmd.id}`}
														onClick={() => startCapture(cmd.id)}
													>
														{m.keymap_rebind()}
													</Button>
													{hasOverride ? (
														<Button
															size="xs"
															variant="ghost"
															aria-label={m.keymap_reset_label({
																command: cmd.label,
															})}
															data-testid={`keymap-reset-${cmd.id}`}
															onClick={() => resetCommand(cmd.id)}
														>
															{m.keymap_reset()}
														</Button>
													) : null}
												</>
											)}
										</div>
									</li>
								);
							})}
						</ul>
					</div>
				))}
			</div>
		</section>
	);
}
