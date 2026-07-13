import { useEffect, useRef } from "react";
import {
	CHORD_MODIFIERS,
	type CommandContext,
	contextsOverlap,
	type EffectiveKeymap,
	MODIFIER_KEYS,
} from "../../domain/keymap.ts";
import { COMMANDS } from "./commands.ts";

// A lone prefix (e.g. "g") that isn't completed within this window is dropped.
const SEQUENCE_TIMEOUT_MS = 800;

type Opts = { activeContext?: CommandContext };

const CONTEXT = new Map<string, CommandContext>(
	COMMANDS.map((c) => [c.id, c.context]),
);

type Lookups = {
	singles: Map<string, string>; // key -> id
	prefixes: Set<string>; // first key of a 2-key sequence
	sequences: Map<string, string>; // "first second" -> id
	chords: Map<string, string>; // non-modifier key of a Meta/Ctrl chord -> id
};

function buildLookups(
	keymap: EffectiveKeymap,
	active: CommandContext,
): Lookups {
	const singles = new Map<string, string>();
	const prefixes = new Set<string>();
	const sequences = new Map<string, string>();
	const chords = new Map<string, string>();
	for (const [id, bindings] of Object.entries(keymap)) {
		const ctx = CONTEXT.get(id) ?? "global";
		if (!contextsOverlap(ctx, active)) continue;
		for (const b of bindings) {
			if (b.length === 1) {
				singles.set(b[0], id);
			} else if (b.length === 2 && CHORD_MODIFIERS.has(b[0])) {
				chords.set(b[1], id);
			} else if (b.length === 2) {
				prefixes.add(b[0]);
				sequences.set(`${b[0]} ${b[1]}`, id);
			}
		}
	}
	return { singles, prefixes, sequences, chords };
}

// Duck-typed so the matcher stays DOM-free (testable under the node vitest env):
// a real HTMLElement, a jsdom node, and a `{ tagName, isContentEditable }` stub
// all satisfy it.
type KeyTarget = { tagName?: string; isContentEditable?: boolean } | null;

function isEditable(target: KeyTarget): boolean {
	if (!target?.tagName) return false;
	const tag = target.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	return target.isContentEditable === true;
}

// Minimal event shape the matcher reads; a real KeyboardEvent satisfies it.
type KeyEventLike = {
	key: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	target?: KeyTarget | EventTarget;
	preventDefault: () => void;
};

// Stateful key matcher: single keys, one Meta/Ctrl chord, and two-key g/d
// sequences with a short timeout. Single-key/sequence bindings are skipped inside
// editable targets so typing never triggers shortcuts; the Meta/Ctrl chord is
// matched FIRST so ⌘K stays the universal palette opener even from a text field.
export function createKeyHandler(
	keymap: EffectiveKeymap,
	run: (id: string) => void,
	opts?: Opts,
) {
	const active = opts?.activeContext ?? "global";
	const { singles, prefixes, sequences, chords } = buildLookups(keymap, active);

	let pending: string | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	function clearPending() {
		pending = null;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}

	function onKeyDown(e: KeyEventLike) {
		const key = e.key;

		// Meta/Ctrl chord (only palette.open in the registry) — matched BEFORE the
		// editable-skip so it fires from inputs too. A held modifier never starts a
		// single-key/sequence match.
		if (e.metaKey || e.ctrlKey) {
			const id = chords.get(key);
			if (id) {
				e.preventDefault();
				run(id);
			}
			clearPending();
			return;
		}

		// Everything below is a single key or g-sequence: inert inside text inputs.
		if (isEditable(e.target as KeyTarget)) return;
		if (MODIFIER_KEYS.has(key)) return;

		// Complete a pending sequence; the prefix is consumed either way.
		if (pending) {
			const seqId = sequences.get(`${pending} ${key}`);
			clearPending();
			if (seqId) {
				e.preventDefault();
				run(seqId);
			}
			return;
		}

		// Start a sequence (prefix wins over any same-key single; none collide today).
		if (prefixes.has(key)) {
			e.preventDefault();
			pending = key;
			timer = setTimeout(clearPending, SEQUENCE_TIMEOUT_MS);
			return;
		}

		const id = singles.get(key);
		if (id) {
			e.preventDefault();
			run(id);
		}
	}

	return { onKeyDown, dispose: clearPending };
}

// Installs a single window keydown listener that dispatches registry commands via
// `run`. Rebinds when the keymap/context changes; `run` is read through a ref so a
// fresh handler each render doesn't leak listeners. Desktop-only (Workspace gates).
export function useKeyBindings(
	keymap: EffectiveKeymap,
	run: (id: string) => void,
	opts?: Opts,
): void {
	const runRef = useRef(run);
	runRef.current = run;
	const activeContext = opts?.activeContext;

	useEffect(() => {
		const handler = createKeyHandler(keymap, (id) => runRef.current(id), {
			activeContext,
		});
		window.addEventListener("keydown", handler.onKeyDown);
		return () => {
			window.removeEventListener("keydown", handler.onKeyDown);
			handler.dispose();
		};
	}, [keymap, activeContext]);
}
