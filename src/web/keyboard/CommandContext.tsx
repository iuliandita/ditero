import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";

export type CommandHandlers = Record<string, () => void>;

type CommandCtx = {
	run: (id: string) => void;
	open: () => void;
	close: () => void;
	isOpen: boolean;
};

const Ctx = createContext<CommandCtx | null>(null);

// Holds the injected handler map + palette open state. The registry (commands.ts)
// stays pure; handlers are wired here at the app shell where the real state lives.
export function CommandProvider({
	handlers,
	children,
}: {
	handlers: CommandHandlers;
	children: React.ReactNode;
}) {
	const [isOpen, setIsOpen] = useState(false);

	// Keep handlers in a ref so `run` has a stable identity across renders even as
	// the caller passes a fresh map each render.
	const handlersRef = useRef(handlers);
	handlersRef.current = handlers;

	const open = useCallback(() => setIsOpen(true), []);
	const close = useCallback(() => setIsOpen(false), []);

	// The provider owns the palette's open state, so it also owns the commands that
	// summon the palette. Callers can override either by passing the id in
	// `handlers`; everything else (task.create, settings.open, ...) comes from the
	// injected map. `/` (search.open) opens the same palette -- it is the unified
	// search surface.
	const run = useCallback(
		(id: string) => {
			const handler = handlersRef.current[id];
			if (handler) {
				handler();
				return;
			}
			if (id === "palette.open" || id === "search.open") {
				open();
				return;
			}
			if (import.meta.env.DEV) console.warn(`[commands] unknown id: ${id}`);
		},
		[open],
	);

	const value = useMemo<CommandCtx>(
		() => ({ run, open, close, isOpen }),
		[run, open, close, isOpen],
	);

	return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCommands(): CommandCtx {
	const ctx = useContext(Ctx);
	if (!ctx)
		throw new Error("useCommands must be used within a CommandProvider");
	return ctx;
}
