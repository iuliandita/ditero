import { expect, test } from "vitest";
import { signInReturnPath } from "./sign-in-return.ts";

test("second-factor completion accepts only safe same-origin app destinations", () => {
	const origin = "https://app.example.test";
	for (const value of [
		"https://evil.example/path",
		"//evil.example/path",
		"javascript:alert(1)",
		"/api/auth/sign-out",
		"/two-factor?callbackURL=/setup",
		"https://app.example.test@evil.example/path",
		"https://app.example.test//evil.example/path",
		"/\\evil.example/path",
	])
		expect(signInReturnPath(value, origin), value).toBe("/");
	for (const value of [
		"/setup",
		"/settings/security",
		"/native/authorize?grantId=abc",
		"/accept#token=fragment",
	])
		expect(signInReturnPath(value, origin)).toBe(value);
	expect(signInReturnPath(`${origin}/setup`, origin)).toBe("/setup");
});
