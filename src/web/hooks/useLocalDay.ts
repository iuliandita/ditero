import { useEffect, useState } from "react";
import { localDay } from "../../domain/local-day.ts";

// Sleeping tabs refresh on focus/visibility; a live tab notices midnight within
// a minute. Only a changed calendar day notifies consumers and invalidates rows.
export function watchLocalDay(
	timeZone: string,
	onChange: (day: string) => void,
	focusTarget: EventTarget = window,
	visibilityTarget: EventTarget = document,
): () => void {
	let day = localDay(new Date(), timeZone);
	const refresh = () => {
		const next = localDay(new Date(), timeZone);
		if (next === day) return;
		day = next;
		onChange(next);
	};
	const timer = setInterval(refresh, 60_000);
	focusTarget.addEventListener("focus", refresh);
	visibilityTarget.addEventListener("visibilitychange", refresh);
	return () => {
		clearInterval(timer);
		focusTarget.removeEventListener("focus", refresh);
		visibilityTarget.removeEventListener("visibilitychange", refresh);
	};
}

export function useLocalDay(timeZone: string): string {
	const [day, setDay] = useState(() => localDay(new Date(), timeZone));
	useEffect(() => {
		setDay(localDay(new Date(), timeZone));
		return watchLocalDay(timeZone, setDay);
	}, [timeZone]);
	return day;
}
