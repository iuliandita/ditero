import { afterEach, describe, expect, it, vi } from "vitest";
import { watchLocalDay } from "./useLocalDay.ts";

afterEach(() => vi.useRealTimers());
describe("watchLocalDay", () => {
	it("notifies once at the local midnight rather than on every minute tick", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-30T21:58:00Z"));
		const changed = vi.fn();
		const stop = watchLocalDay(
			"Europe/Berlin",
			changed,
			new EventTarget(),
			new EventTarget(),
		);
		vi.advanceTimersByTime(60_000);
		expect(changed).not.toHaveBeenCalled();
		vi.advanceTimersByTime(60_000);
		expect(changed).toHaveBeenCalledExactlyOnceWith("2026-10-01");
		vi.advanceTimersByTime(60_000);
		expect(changed).toHaveBeenCalledTimes(1);
		stop();
		vi.advanceTimersByTime(86_400_000);
		expect(changed).toHaveBeenCalledTimes(1);
	});
	it("refreshes sleeping tabs on focus or visibility and removes listeners on cleanup", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-01T02:00:00Z"));
		const focus = new EventTarget();
		const visibility = new EventTarget();
		const changed = vi.fn();
		const stop = watchLocalDay("America/New_York", changed, focus, visibility);
		vi.setSystemTime(new Date("2026-10-01T05:00:00Z"));
		focus.dispatchEvent(new Event("focus"));
		expect(changed).toHaveBeenCalledExactlyOnceWith("2026-10-01");
		visibility.dispatchEvent(new Event("visibilitychange"));
		expect(changed).toHaveBeenCalledTimes(1);
		vi.setSystemTime(new Date("2026-10-02T05:00:00Z"));
		visibility.dispatchEvent(new Event("visibilitychange"));
		expect(changed).toHaveBeenLastCalledWith("2026-10-02");
		stop();
		vi.setSystemTime(new Date("2026-10-03T05:00:00Z"));
		focus.dispatchEvent(new Event("focus"));
		expect(changed).toHaveBeenCalledTimes(2);
	});
});
