import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { NavGroup } from "./Sidebar.tsx";

test("a heading control replaces the text title and the block keeps its name", () => {
	const html = renderToStaticMarkup(
		<NavGroup
			title="Lists"
			section="lists"
			heading={<button type="button">Maple household</button>}
		>
			<ul />
		</NavGroup>,
	);
	expect(html).toContain('aria-label="Lists"');
	expect(html).not.toContain("aria-labelledby");
	expect(html.indexOf("Maple household")).toBeLessThan(html.indexOf("<ul"));
	expect(html).not.toContain(">Lists</div>");
});
