import { expect, test } from "vitest";
import { authBaseURL } from "./base-url.ts";

test("production requires a configured auth origin", () => {
	expect(() => authBaseURL({ NODE_ENV: "production" })).toThrow(
		/required in production/,
	);
	expect(authBaseURL({ NODE_ENV: "test" })).toBe("http://localhost:3000");
	expect(authBaseURL({})).toBe("http://localhost:3000");
});

test("uses the configured auth origin with a public-origin fallback", () => {
	expect(
		authBaseURL({
			NODE_ENV: "production",
			DITERO_PUBLIC_URL: "https://public.example.test/",
		}),
	).toBe("https://public.example.test");
	expect(
		authBaseURL({
			BETTER_AUTH_URL: "https://auth.example.test/",
			DITERO_PUBLIC_URL: "https://public.example.test",
		}),
	).toBe("https://auth.example.test");
	expect(authBaseURL({ BETTER_AUTH_URL: "http://localhost:3000" })).toBe(
		"http://localhost:3000",
	);
});

test.each([
	"",
	"not a URL",
	"ftp://auth.example.test",
	"https://user:secret@auth.example.test",
	"https://auth.example.test/path",
	"https://auth.example.test/?query=1",
	"https://auth.example.test/#fragment",
])("refuses invalid configured auth origin %s", (configured) => {
	expect(() => authBaseURL({ BETTER_AUTH_URL: configured })).toThrow(
		/HTTP or HTTPS origin/,
	);
});
