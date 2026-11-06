import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { MemberAvatar } from "./avatar.tsx";

afterEach(() => vi.unstubAllGlobals());
test.each([
	["/avatars/me.png", true],
	["https://app.example/avatar.png", true],
	["data:image/png;base64,aGVsbG8=", true],
	["https://tracker.example/avatar.png", false],
	["//tracker.example/a", false],
	["javascript:alert(1)", false],
	["blob:https://app.example/id", false],
	["https://user:password@app.example/a", false],
	["http://app.example/a", false],
])("avatar URL %s is allowed: %s", (image, allowed) => {
	vi.stubGlobal("window", { location: { origin: "https://app.example" } });
	const html = renderToStaticMarkup(
		<MemberAvatar name="Test Person" image={image} />,
	);
	expect(html.includes("<img")).toBe(allowed);
	if (!allowed) expect(html).toContain("TP");
});
