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

type Opts = {
	activeContext?: CommandContext;
	// Consulted before a matched command claims its key. A command that cannot
	// act right now (no selectable rows for select-all) leaves the key to the
	// browser instead of swallowing it.
	canRun?: (id: string) => boolean;
	// Commands the user rebound. They are tried first when a key is shared, so a
	// deliberate remap onto a default key (task.create on `s`) wins over it.
	preferred?: ReadonlySet<string>;
};

// Selection chords (select-all) never fire from a text field: there the chord
// belongs to the field. Every other chord keeps firing from inputs, as ⌘K does.
const blockedInEditable = (id: string): boolean => id.startsWith("selection.");

const CONTEXT = new Map<string, CommandContext>(
	COMMANDS.map((c) => [c.id, c.context]),
);

// Each key maps to every command bound to it, in priority order: a user's
// rebind first, then registry order. The first one that can run takes the key,
// so a command that cannot act right now never swallows a key another command
// shares with it.
type Candidates = Map<string, string[]>;
type Lookups = {
	singles: Candidates; // key -> ids
	prefixes: Set<string>; // first key of a 2-key sequence
	sequences: Candidates; // "first second" -> ids
	chords: Candidates; // non-modifier key of a Meta/Ctrl chord -> ids
	shifted: Candidates; // key of a ["Shift", key] binding -> ids
};

function add(map: Candidates, key: string, id: string) {
	const ids = map.get(key);
	if (ids) ids.push(id);
	else map.set(key, [id]);
}

function buildLookups(
	keymap: EffectiveKeymap,
	active: CommandContext,
	preferred: ReadonlySet<string>,
): Lookups {
	const singles: Candidates = new Map();
	const prefixes = new Set<string>();
	const sequences: Candidates = new Map();
	const chords: Candidates = new Map();
	const shifted: Candidates = new Map();
	const ids = Object.keys(keymap);
	const ordered = [
		...ids.filter((id) => preferred.has(id)),
		...ids.filter((id) => !preferred.has(id)),
	];
	for (const id of ordered) {
		const ctx = CONTEXT.get(id) ?? "global";
		if (!contextsOverlap(ctx, active)) continue;
		for (const b of keymap[id]) {
			if (b.length === 1) {
				add(singles, b[0], id);
			} else if (b.length === 2 && CHORD_MODIFIERS.has(b[0])) {
				add(chords, b[1], id);
			} else if (b.length === 2 && b[0] === "Shift") {
				add(shifted, b[1], id);
			} else if (b.length === 2) {
				prefixes.add(b[0]);
				add(sequences, `${b[0]} ${b[1]}`, id);
			}
		}
	}
	return { singles, prefixes, sequences, chords, shifted };
}

// Duck-typed so the matcher stays DOM-free (testable under the node vitest env):
// a real HTMLElement, a jsdom node, and a `{ tagName, isContentEditable }` stub
// all satisfy it.
type KeyTarget = { tagName?: string; isContentEditable?: boolean } | null;

export function isEditable(target: KeyTarget): boolean {
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
	shiftKey?: boolean;
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
	const { singles, prefixes, sequences, chords, shifted } = buildLookups(
		keymap,
		active,
		opts?.preferred ?? new Set(),
	);
	const canRun = opts?.canRun ?? (() => true);
	const pick = (
		ids: string[] | undefined,
		allowed: (id: string) => boolean = () => true,
	): string | undefined => ids?.find((id) => allowed(id) && canRun(id));

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

		// Meta/Ctrl chord, matched BEFORE the editable-skip so ⌘K fires from inputs
		// too. A held modifier never starts a single-key/sequence match.
		if (e.metaKey || e.ctrlKey) {
			const editable = isEditable(e.target as KeyTarget);
			const id = pick(
				chords.get(key),
				(candidate) => !editable || !blockedInEditable(candidate),
			);
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

		// An explicit Shift binding (Shift+ArrowDown). Shifted printable keys like
		// "?" arrive already shifted and fall through to the single-key lookup,
		// as does a Shift binding that cannot run.
		const shiftedId = e.shiftKey ? pick(shifted.get(key)) : undefined;
		if (shiftedId) {
			clearPending();
			e.preventDefault();
			run(shiftedId);
			return;
		}

		// Complete a pending sequence; the prefix is consumed either way.
		if (pending) {
			const seqId = pick(sequences.get(`${pending} ${key}`));
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

		const id = pick(singles.get(key));
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
	const canRunRef = useRef(opts?.canRun);
	canRunRef.current = opts?.canRun;
	const activeContext = opts?.activeContext;
	const preferred = opts?.preferred;

	useEffect(() => {
		const handler = createKeyHandler(keymap, (id) => runRef.current(id), {
			activeContext,
			preferred,
			canRun: (id) => canRunRef.current?.(id) ?? true,
		});
		window.addEventListener("keydown", handler.onKeyDown);
		return () => {
			window.removeEventListener("keydown", handler.onKeyDown);
			handler.dispose();
		};
	}, [keymap, activeContext, preferred]);
}
