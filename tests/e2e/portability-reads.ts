import { expect, type Page } from "@playwright/test";

export async function readPortabilityExport(page: Page, query = "") {
	for (let attempt = 0; ; attempt++) {
		const response = await page.request.get(`/api/portability/export${query}`);
		if (response.status() !== 429 || attempt === 2) {
			expect(response.status()).toBe(200);
			return response;
		}
		const seconds = Number(response.headers()["retry-after"] ?? "0.5");
		expect(seconds).toBeGreaterThanOrEqual(0);
		expect(seconds).toBeLessThanOrEqual(5);
		await response.dispose();
		await new Promise((resolve) =>
			setTimeout(resolve, Math.max(100, seconds * 1000)),
		);
	}
}
