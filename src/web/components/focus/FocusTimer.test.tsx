import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { DEFAULT_FOCUS, INITIAL_CYCLE } from "../../focus/timer-core.ts";
import type { FocusTimerApi } from "../../focus/useFocusTimer.tsx";
import { FocusTimer } from "./FocusTimer.tsx";

const fixture = vi.hoisted(() => ({ api: {} as FocusTimerApi }));
vi.mock("../../focus/useFocusTimer.tsx", () => ({
	useFocusTimer: () => fixture.api,
}));

test("the pill displays the provider's remaining time instead of the wall clock", () => {
	fixture.api = {
		session: {
			intervalId: "interval",
			cycle: INITIAL_CYCLE,
			config: DEFAULT_FOCUS,
			plannedSec: 10,
			running: true,
			startedAt: 10000,
			endsAt: 20000,
			remainingSec: 7,
			boundTaskId: null,
			boundTaskTitle: null,
		},
		roundsPerLongBreak: 4,
		cue: null,
		error: null,
	} as FocusTimerApi;
	const html = renderToStaticMarkup(<FocusTimer />);
	expect(html).toContain('data-testid="focus-countdown"');
	expect(html).toContain("00:07");
});

test("a refused completion stays visible and dismissible after Stop", () => {
	fixture.api = {
		...fixture.api,
		session: null,
		error: "This interval couldn't be saved. It won't be retried.",
		dismissError: vi.fn(),
	};
	const html = renderToStaticMarkup(<FocusTimer />);
	expect(html).toContain('role="alert"');
	expect(html).toContain('data-testid="focus-error"');
	expect(html).toContain("This interval couldn&#x27;t be saved.");
	expect(html).toContain("Close</button>");
});
