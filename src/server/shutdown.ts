import { setTimeout as sleep } from "node:timers/promises";
import type { Cron } from "croner";

type ShutdownOptions = {
	server: { stop(force?: boolean): Promise<void> };
	jobs: Pick<Cron, "stop" | "isBusy">[];
	stopBackground: (() => void | Promise<void>)[];
	closeDatabase: () => Promise<void>;
	exit?: (code: number) => void;
	drainMs?: number;
	deadlineMs?: number;
};

export function createShutdown(options: ShutdownOptions): () => Promise<void> {
	let running: Promise<void> | undefined;
	const exit = options.exit ?? process.exit;
	return () => {
		if (running) return running;
		running = (async () => {
			console.log("ditero: shutting down");
			// Keep time for pool cleanup before Docker's default 10-second kill.
			const deadline = setTimeout(() => {
				console.error(
					"ditero: shutdown deadline reached; unfinished leases will be reclaimed",
				);
				exit(0);
			}, options.deadlineMs ?? 8_000);
			let drainTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				for (const job of options.jobs) job.stop();
				const background = options.stopBackground.map(async (stop) => stop());
				const drain = Promise.all([
					options.server.stop(false),
					...background,
					(async () => {
						while (options.jobs.some((job) => job.isBusy())) await sleep(20);
					})(),
				]);
				await Promise.race([
					drain,
					new Promise<void>((resolve) => {
						drainTimer = setTimeout(() => {
							console.warn(
								"ditero: drain deadline reached; closing active requests",
							);
							void options.server.stop(true).catch(() => {});
							resolve();
						}, options.drainMs ?? 5_000);
					}),
				]);
			} catch {
				console.error(
					"ditero: shutdown cleanup failed; unfinished leases will be reclaimed",
				);
			} finally {
				clearTimeout(drainTimer);
				try {
					await options.closeDatabase();
				} catch {
					console.error("ditero: database shutdown failed");
				}
				clearTimeout(deadline);
				exit(0);
			}
		})();
		return running;
	};
}
