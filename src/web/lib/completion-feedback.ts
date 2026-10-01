import { useState } from "react";
import { cn } from "./utils.ts";

// The strike is a scaled pseudo-element rather than text-decoration so the
// completion animates on transform alone. It needs an inline host to span the
// text rather than the row. Forced-colors mode drops backgrounds, so the real
// line-through takes over there.
export function strikeClass(done: boolean): string {
	return cn(
		"relative after:pointer-events-none after:absolute after:inset-x-0 after:top-1/2 after:h-px after:origin-left after:bg-current after:transition-transform after:duration-(--motion-base) after:ease-(--motion-ease) motion-reduce:after:transition-none rtl:after:origin-right",
		done ? "after:scale-x-100 forced-colors:line-through" : "after:scale-x-0",
	);
}

// True from the render where `done` flips false -> true until it flips back.
// The check indicator mounts on every check, including initial render and
// opening the completed group, so the pop class is applied only after a real
// transition on this mounted row.
export function useJustCompleted(done: boolean): boolean {
	const [prev, setPrev] = useState(done);
	const [just, setJust] = useState(false);
	if (prev !== done) {
		setPrev(done);
		setJust(done);
	}
	return just;
}

export const CHECK_POP = "check-pop";
