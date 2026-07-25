import type { Page } from "@playwright/test";

// Playwright pins the browser's timezone (playwright.config `timezoneId`) while
// this runner process keeps the host's, so the two are a different calendar day
// for part of every day. Anything the app resolves against the USER's local day
// -- habit_log dates, a due date that must read "Today" -- has to be taken from
// the page, never computed here.
export function browserToday(page: Page): Promise<string> {
	return page.evaluate(() => {
		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	});
}

// Whole-day arithmetic on a "YYYY-MM-DD" string. Anchored at UTC midnight purely
// as a fixed 24h grid, so it shifts the calendar label without reintroducing a
// zone: shifting a browser-local day stays a browser-local day.
export function shiftDay(day: string, days: number): string {
	const at = Date.parse(`${day}T00:00:00Z`);
	if (Number.isNaN(at)) throw new Error(`shiftDay: bad day ${day}`);
	return new Date(at + days * 86_400_000).toISOString().slice(0, 10);
}
