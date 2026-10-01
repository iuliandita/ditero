import {
	CalendarDays,
	Inbox,
	LayoutDashboard,
	ListFilter,
	SquareKanban,
	Sun,
	Table2,
	UserCheck,
} from "lucide-react";
import { describe, expect, test } from "vitest";
import { ICONS } from "./list-icon.tsx";
import { dashboardIcon, viewIcon } from "./nav-icon.tsx";

describe("viewIcon", () => {
	test("built-ins each get their own glyph", () => {
		expect(viewIcon({ id: "today" })).toBe(Sun);
		expect(viewIcon({ id: "all-my-tasks" })).toBe(Inbox);
		expect(viewIcon({ id: "assigned-to-me" })).toBe(UserCheck);
	});

	test("a saved view without an icon follows its layout", () => {
		const of = (layout: string) =>
			viewIcon({ id: "v1", icon: null, display: { layout } });
		expect(of("list")).toBe(ListFilter);
		expect(of("board")).toBe(SquareKanban);
		expect(of("table")).toBe(Table2);
		expect(of("calendar")).toBe(CalendarDays);
		expect(new Set(["list", "board", "table", "calendar"].map(of)).size).toBe(
			4,
		);
	});

	test("a picked icon wins, and prototype keys fall back safely", () => {
		expect(
			viewIcon({ id: "v1", icon: "dog", display: { layout: "board" } }),
		).toBe(ICONS.dog);
		expect(
			viewIcon({
				id: "v1",
				icon: "constructor",
				display: { layout: "toString" },
			}),
		).toBe(ListFilter);
		expect(viewIcon({ id: "__proto__" })).toBe(ListFilter);
	});
});

describe("dashboardIcon", () => {
	test("defaults to the dashboard glyph, never the list mark", () => {
		expect(dashboardIcon({ icon: null })).toBe(LayoutDashboard);
		expect(dashboardIcon({ icon: "constructor" })).toBe(LayoutDashboard);
		expect(dashboardIcon({ icon: "star" })).toBe(ICONS.star);
	});
});
