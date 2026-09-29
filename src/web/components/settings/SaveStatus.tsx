import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";

export type SaveState = "idle" | "saving" | "saved" | "error";

// Tracks a pref write through to the server's answer. Only the latest write
// reports, so a slow earlier save cannot overwrite a newer one's outcome. A
// rejected write matters here because the control snaps back to the stored
// value, which would otherwise look like the click was ignored.
export function useSaveStatus() {
	const sequence = useRef(0);
	const [state, setState] = useState<SaveState>("idle");
	const track = useCallback((write: Promise<boolean>) => {
		const current = ++sequence.current;
		setState("saving");
		void write.then((succeeded) => {
			if (current === sequence.current) setState(succeeded ? "saved" : "error");
		});
	}, []);
	return { state, track };
}

export function SaveStatus({
	state,
	className,
	"data-testid": testId,
}: {
	state: SaveState;
	className?: string;
	"data-testid"?: string;
}) {
	if (state === "idle") return null;
	return (
		<p
			role={state === "error" ? "alert" : "status"}
			data-testid={testId}
			className={cn(
				"text-xs",
				state === "error" ? "text-destructive" : "text-muted-foreground",
				className,
			)}
		>
			{state === "saving"
				? m.quiet_hours_saving()
				: state === "saved"
					? m.quiet_hours_saved()
					: m.mutation_failed()}
		</p>
	);
}
