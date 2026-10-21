import { expect, test } from "vitest";
import { syncEndpointDetail } from "./sync-endpoint.ts";

test.each([
	["http://sync.example.test", "https://app.example.test", "mixed-content"],
	["ws://sync.example.test", "https://app.example.test", "mixed-content"],
	["http://localhost:4599", "http://app.example.test", "localhost"],
	["http://localhost:4599", "https://app.example.test", "localhost"],
	["http://localhost:4599", "https://localhost", null],
	["http://127.0.0.1:4599", "http://app.example.test", "localhost"],
	["http://[::1]:4599", "http://app.example.test", "localhost"],
	["http://localhost:4599", "http://localhost:5173", null],
	["https://sync.example.test", "https://app.example.test", null],
] as const)("diagnoses %s from %s", (endpoint, page, problem) => {
	expect(syncEndpointDetail(endpoint, page)?.problem).toBe(problem);
});

test("excludes credentials and tokens from the displayed address", () => {
	expect(
		syncEndpointDetail(
			"https://user:secret@sync.example.test/path?token=secret#secret",
			"https://app.example.test",
		),
	).toEqual({ address: "https://sync.example.test/path", problem: null });
});
