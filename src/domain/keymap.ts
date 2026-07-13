export type Binding = string[]; // a key chord/sequence, e.g. ["g","i"] or ["Meta","k"]
export type CommandContext = "global" | "list" | "board" | "table";
export type CommandDef = {
	id: string;
	category: string;
	label: string;
	bindings: { default: Binding[]; vim?: Binding[] };
	context: CommandContext;
};
export type EffectiveKeymap = Record<string, Binding[]>;

// vim falls back to default when a command has no vim binding; overrides replace
// a command's bindings entirely (design 2.19 remap store: user_pref.keymap).
export function resolveKeymap(
	commands: CommandDef[],
	profile: "default" | "vim",
	overrides: Record<string, Binding[]>,
): EffectiveKeymap {
	const km: EffectiveKeymap = {};
	for (const cmd of commands) {
		km[cmd.id] =
			overrides[cmd.id] ??
			(profile === "vim"
				? (cmd.bindings.vim ?? cmd.bindings.default)
				: cmd.bindings.default);
	}
	return km;
}

// A binding is a key SEQUENCE; its identity is the whole array, so ["g","i"] and
// ["g"] never collide.
const serialize = (b: Binding): string => b.join(" ");

// global overlaps every context (incl. another global); two non-global contexts
// overlap only when equal (list+list yes, list+board no).
const contextsOverlap = (a: CommandContext, b: CommandContext): boolean =>
	a === "global" || b === "global" || a === b;

export function findConflicts(
	km: EffectiveKeymap,
	commands: CommandDef[],
): [string, string][] {
	const ctx = new Map(commands.map((c) => [c.id, c.context]));
	const ids = Object.keys(km);
	const pairs: [string, string][] = [];
	for (let i = 0; i < ids.length; i++) {
		for (let j = i + 1; j < ids.length; j++) {
			const a = ids[i];
			const b = ids[j];
			const ca = ctx.get(a);
			const cb = ctx.get(b);
			if (!ca || !cb || !contextsOverlap(ca, cb)) continue;
			const keysA = new Set(km[a].map(serialize));
			const shared = km[b].some((binding) => keysA.has(serialize(binding)));
			if (shared) pairs.push(a < b ? [a, b] : [b, a]);
		}
	}
	pairs.sort((p, q) =>
		p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0,
	);
	return pairs;
}
