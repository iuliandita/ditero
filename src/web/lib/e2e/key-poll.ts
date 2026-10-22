export type KeyPoll = { stop: () => void };

export type KeyPollOptions = {
	intervalMs: number;
	/** Failures double the delay up to this ceiling; a success resets it. */
	maxIntervalMs?: number;
	/** Stops after this many runs, successful or not. */
	maxRuns?: number;
	/** Delay before the first run; defaults to intervalMs. */
	initialDelayMs?: number;
	/** Called once when maxRuns ends the poll without a run resolving true. */
	onExhausted?: () => void;
	/** Resolving true ends the poll. */
	run: () => Promise<unknown>;
	onError: (error: unknown) => void;
};

/**
 * Chained timeouts rather than an interval: the next run is scheduled only
 * after the previous one settles, so a slow request never overlaps itself.
 */
export function startKeyPoll(options: KeyPollOptions): KeyPoll {
	const ceiling = options.maxIntervalMs ?? options.intervalMs;
	let delay = options.initialDelayMs ?? options.intervalMs;
	let runs = 0;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const schedule = () => {
		if (stopped) return;
		if (options.maxRuns !== undefined && runs >= options.maxRuns) {
			stopped = true;
			options.onExhausted?.();
			return;
		}
		timer = setTimeout(tick, delay);
	};

	const tick = async () => {
		timer = undefined;
		if (stopped) return;
		runs += 1;
		try {
			const done = await options.run();
			delay = options.intervalMs;
			if (done === true) {
				stopped = true;
				return;
			}
		} catch (error) {
			if (stopped) return;
			options.onError(error);
			delay = Math.min(Math.max(delay, options.intervalMs) * 2, ceiling);
		}
		schedule();
	};

	schedule();
	return {
		stop() {
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
		},
	};
}
