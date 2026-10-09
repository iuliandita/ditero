import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskSourceContext } from "./TaskSourceContext.tsx";

describe("TaskSourceContext", () => {
	it.each([
		["personal", "UserRound", "Casa · Personal"],
		["shared", "UsersRound", "Casa · Compartido"],
	] as const)("uses the %s pictogram with the full localized context", (kind, icon, context) => {
		const html = renderToStaticMarkup(
			<TaskSourceContext
				context={context}
				workspace={{ name: "Casa", kind }}
			/>,
		);
		expect(html).toContain(`title="${context}"`);
		expect(html).toContain(`class="sr-only">${context}</span>`);
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain(
			icon === "UserRound" ? "lucide-user-round" : "lucide-users-round",
		);
		expect(html).toContain(">Casa</span>");
	});

	it("keeps the original context visible when structured metadata is unavailable", () => {
		const html = renderToStaticMarkup(
			<TaskSourceContext context="Home · Personal" />,
		);
		expect(html).toContain(">Home · Personal</span>");
		expect(html).not.toContain("<svg");
	});
});
