import { expect } from "vitest";
import { handleAuthRequest } from "../../src/auth/auth.ts";

export async function signInForTest(email: string, password = "pw-123456") {
	const response = await handleAuthRequest(
		new Request("http://localhost:3000/api/auth/sign-in/email", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:5173",
			},
			body: JSON.stringify({ email, password }),
		}),
	);
	expect(response.status, await response.clone().text()).toBe(200);
	return response;
}
