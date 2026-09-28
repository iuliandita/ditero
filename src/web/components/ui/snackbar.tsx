import { X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useReducer,
	useRef,
} from "react";
import { FLIP_TRANSITION, MOTION_EASE } from "@/lib/motion";
import { m } from "../../../paraglide/messages.js";
import { isEditable } from "../../keyboard/useKeyBindings.ts";
import {
	type Countdown,
	EMPTY_SNACKBAR,
	pauseCountdown,
	resumeCountdown,
	SNACKBAR_MS,
	type SnackAction,
	snackbarReducer,
	startCountdown,
} from "./snackbar-state.ts";

type ShowSnack = (snack: { message: string; action?: SnackAction }) => void;

const SnackbarContext = createContext<ShowSnack | null>(null);

// One shared, non-blocking notice with an optional action (Undo). It never takes
// focus; Ctrl/Cmd+Z runs the action from anywhere outside a text field, so a
// keyboard user who completed a row with `x` does not have to tab to it.
export function SnackbarProvider({ children }: { children: ReactNode }) {
	const [state, dispatch] = useReducer(snackbarReducer, EMPTY_SNACKBAR);
	const reduce = useReducedMotion();
	const snack = state.snack;
	const countdown = useRef<Countdown | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hovered = useRef(false);
	const focused = useRef(false);

	const show = useCallback<ShowSnack>(
		(next) => dispatch({ type: "show", ...next }),
		[],
	);

	const schedule = useCallback((id: number, c: Countdown) => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(
			() => dispatch({ type: "dismiss", id }),
			c.remaining,
		);
	}, []);

	useEffect(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		if (!snack) return;
		hovered.current = false;
		focused.current = false;
		countdown.current = startCountdown(SNACKBAR_MS, Date.now());
		schedule(snack.id, countdown.current);
		return () => {
			if (timer.current) clearTimeout(timer.current);
		};
	}, [snack, schedule]);

	const syncPause = useCallback(() => {
		if (!snack || !countdown.current) return;
		if (hovered.current || focused.current) {
			if (timer.current) clearTimeout(timer.current);
			countdown.current = pauseCountdown(countdown.current, Date.now());
		} else if (countdown.current.startedAt === null) {
			countdown.current = resumeCountdown(countdown.current, Date.now());
			schedule(snack.id, countdown.current);
		}
	}, [snack, schedule]);

	const act = useCallback(() => {
		if (!snack?.action) return;
		dispatch({ type: "dismiss", id: snack.id });
		snack.action.run();
	}, [snack]);

	useEffect(() => {
		if (!snack?.action) return;
		function onKeyDown(e: KeyboardEvent) {
			if (e.key.toLowerCase() !== "z" || e.shiftKey || e.altKey) return;
			if (!(e.metaKey || e.ctrlKey)) return;
			if (isEditable(e.target as HTMLElement | null)) return;
			e.preventDefault();
			act();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [snack, act]);

	return (
		<SnackbarContext.Provider value={show}>
			{children}
			{/* Always mounted: a live region inserted together with its text is
			    announced unreliably. The visible copy below is aria-hidden so the
			    message is read once. */}
			<div
				role="status"
				aria-live="polite"
				aria-atomic
				data-testid="snackbar-live"
				className="sr-only"
			>
				{snack?.message ?? ""}
			</div>
			<div className="pointer-events-none fixed inset-x-0 bottom-[calc(9.5rem+env(safe-area-inset-bottom))] z-50 flex justify-center px-4 md:bottom-6">
				<AnimatePresence mode="wait" initial={false}>
					{snack && (
						<motion.div
							key={snack.id}
							data-testid="snackbar"
							initial={reduce ? false : { opacity: 0, y: 8 }}
							animate={{ opacity: 1, y: 0 }}
							exit={
								reduce
									? { opacity: 0, transition: { duration: 0 } }
									: {
											opacity: 0,
											transition: { duration: 0.1, ease: MOTION_EASE },
										}
							}
							transition={reduce ? { duration: 0 } : FLIP_TRANSITION}
							onPointerEnter={() => {
								hovered.current = true;
								syncPause();
							}}
							onPointerLeave={() => {
								hovered.current = false;
								syncPause();
							}}
							onFocus={() => {
								focused.current = true;
								syncPause();
							}}
							onBlur={(e) => {
								if (e.currentTarget.contains(e.relatedTarget as Node | null))
									return;
								focused.current = false;
								syncPause();
							}}
							onKeyDown={(e) => {
								if (e.key === "Escape")
									dispatch({ type: "dismiss", id: snack.id });
							}}
							className="pointer-events-auto flex max-w-md min-w-0 items-center gap-1 rounded-xl bg-foreground py-1 ps-4 pe-1 text-background shadow-floating"
						>
							<p
								aria-hidden
								className="line-clamp-2 min-w-0 flex-1 py-2 text-sm break-words"
							>
								{snack.message}
							</p>
							{snack.action && (
								<button
									type="button"
									data-testid="snackbar-action"
									onClick={act}
									className="min-h-11 shrink-0 rounded-lg px-3 text-sm font-semibold hover:bg-background/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-background md:min-h-9"
								>
									{snack.action.label}
								</button>
							)}
							<button
								type="button"
								aria-label={m.action_close()}
								onClick={() => dispatch({ type: "dismiss", id: snack.id })}
								className="flex size-11 shrink-0 items-center justify-center rounded-lg text-background/70 hover:bg-background/15 hover:text-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-background md:size-9"
							>
								<X className="size-4" />
							</button>
						</motion.div>
					)}
				</AnimatePresence>
			</div>
		</SnackbarContext.Provider>
	);
}

export function useSnackbar(): ShowSnack {
	const show = useContext(SnackbarContext);
	if (!show) throw new Error("useSnackbar requires a SnackbarProvider");
	return show;
}
