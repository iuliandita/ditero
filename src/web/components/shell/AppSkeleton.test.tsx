import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	BootSkeleton,
	ShellSkeleton,
	TaskRowsSkeleton,
} from "./AppSkeleton.tsx";

describe("AppSkeleton", () => {
	it("the signed-in silhouette carries the phone header and the three-tab bar", () => {
		const html = renderToStaticMarkup(<ShellSkeleton />);
		expect(html).toContain("h-14 items-center gap-2 border-b");
		expect(html).toContain("grid-cols-3");
		expect(html.match(/h-9 w-12/g)).toHaveLength(3);
	});

	it("the undecided-session silhouette predicts no workspace chrome", () => {
		const html = renderToStaticMarkup(<BootSkeleton />);
		expect(html).not.toContain("bg-sidebar");
		expect(html).not.toContain("grid-cols-3");
	});

	it("rows match the 48px task row", () => {
		expect(renderToStaticMarkup(<TaskRowsSkeleton rows={2} />)).toContain(
			"min-h-12",
		);
	});
});
