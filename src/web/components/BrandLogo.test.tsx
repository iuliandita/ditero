import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { BrandLogo } from "./BrandLogo.tsx";

test("the shared wordmark has one accessible name and decorative theme variants", () => {
	const html = renderToStaticMarkup(<BrandLogo className="mb-7" />);
	expect(html).toContain('class="sr-only">Ditero</span>');
	expect(html.match(/<img /g)).toHaveLength(2);
	expect(html.match(/alt="" aria-hidden="true"/g)).toHaveLength(2);
	expect(html).toContain("ditero-wordmark-light.png");
	expect(html).toContain("ditero-wordmark-dark.png");
	expect(html).toContain("dark:hidden");
	expect(html).toContain("dark:block");
	expect(html).toContain("max-w-full mb-7");
});
