import {
	type APIResponse,
	expect,
	type Page,
	type Route,
} from "@playwright/test";

async function retryRead(
	request: (timeout: number) => Promise<APIResponse>,
): Promise<APIResponse> {
	const deadline = Date.now() + 15_000;
	for (let attempt = 0; ; attempt++) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("Portability fixture read timed out");
		const response = await request(remaining);
		if (response.status() !== 429 || attempt === 2) return response;
		const seconds = Number(response.headers()["retry-after"] ?? "0.5");
		if (!Number.isFinite(seconds) || seconds < 0 || seconds > 5)
			return response;
		const delay = Math.max(100, seconds * 1000);
		if (Date.now() + delay >= deadline) return response;
		await response.dispose();
		await new Promise((resolve) => setTimeout(resolve, delay));
	}
}

export async function readPortabilityExport(page: Page, query = "") {
	const response = await retryRead((timeout) =>
		page.request.get(`/api/portability/export${query}`, { timeout }),
	);
	expect(response.status()).toBe(200);
	return response;
}

// Capture a successful read before holding its response for a retirement check.
export async function fetchPortabilityRead(route: Route): Promise<APIResponse> {
	expect(route.request().method()).toBe("GET");
	return retryRead((timeout) => route.fetch({ timeout, maxRetries: 0 }));
}
