import { useEffect, useRef } from "react";
import { m } from "../../paraglide/messages.js";
import { connectionRetry } from "../lib/connection-required.ts";
import { Button } from "./ui/button.tsx";

export function ConnectionRequired({
	onRetry,
}: {
	onRetry: () => Promise<unknown>;
}) {
	const heading = useRef<HTMLHeadingElement>(null);
	const retry = useRef<ReturnType<typeof connectionRetry> | null>(null);
	useEffect(() => {
		heading.current?.focus();
	}, []);
	useEffect(() => {
		const owner = connectionRetry(onRetry, window);
		retry.current = owner;
		return () => {
			owner.stop();
			retry.current = null;
		};
	}, [onRetry]);
	return (
		<main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground">
			<h1 ref={heading} tabIndex={-1} className="text-xl font-semibold">
				{m.startup_connection_heading()}
			</h1>
			<p className="max-w-md">{m.startup_connection_body()}</p>
			<Button onClick={() => void retry.current?.retry()}>
				{m.startup_connection_retry()}
			</Button>
		</main>
	);
}
