import { expect, test, vi } from "vitest";
import { httpErrorMessage } from "./http-error.ts";

test("shows the localized fallback for server failures without reading their body, while preserving intended client errors", async () => {
	for (const status of [500, 503]) {
		const response = Response.json(
			{ code: "internal-error", correlationId: "id", message: "private" },
			{ status },
		);
		const read = vi.spyOn(response, "text");
		expect(await httpErrorMessage(response, "Localized failure", true)).toBe(
			"Localized failure",
		);
		expect(read).not.toHaveBeenCalled();
	}
	expect(
		await httpErrorMessage(
			new Response("typed refusal", { status: 403 }),
			"fallback",
		),
	).toBe("typed refusal");
	expect(
		await httpErrorMessage(
			Response.json({ message: "typed message" }, { status: 400 }),
			"fallback",
			true,
		),
	).toBe("typed message");
});
