import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
	type PersonalAccessTokenMetadata,
	PersonalAccessTokenRows,
	PersonalAccessTokensPanel,
	requestPersonalAccessTokens,
	tokenErrorMessage,
	tokenStatus,
} from "./PersonalAccessTokensPanel.tsx";

vi.mock("../../lib/auth-client.ts", () => ({
	authClient: { useSession: () => ({ data: null }) },
}));
vi.mock("../../../paraglide/runtime.js", () => ({
	getLocale: () => "en",
	experimentalStaticLocale: undefined,
}));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

const token: PersonalAccessTokenMetadata = {
	id: "b27f2ae3-62e3-411f-8d38-02ad94d07f12",
	name: "Terminal client",
	hint: "abcd",
	access: "read",
	createdAt: "2026-01-01T00:00:00.000Z",
	expiresAt: "2026-06-01T00:00:00.000Z",
	revokedAt: null,
};

describe("token metadata", () => {
	test("expiration takes effect at the exact boundary and revocation wins", () => {
		const expiration = Date.parse(token.expiresAt);
		expect(tokenStatus(token, expiration - 1)).toBe("active");
		expect(tokenStatus(token, expiration)).toBe("expired");
		expect(
			tokenStatus({ ...token, revokedAt: token.createdAt }, expiration - 1),
		).toBe("revoked");
	});

	test("rows distinguish access, status and hint without displaying secrets", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
		const markup = renderToStaticMarkup(
			<PersonalAccessTokenRows
				tokens={[
					{ ...token, name: "<script>client</script>" },
					{
						...token,
						id: "50a00d99-51f6-4ea2-9d73-69196f852555",
						name: "Expired client",
						access: "write",
						expiresAt: token.createdAt,
					},
					{
						...token,
						id: "983a211a-58f9-4b38-957f-1b9dfcfdfab2",
						name: "Revoked client",
						revokedAt: token.createdAt,
					},
				]}
				busy={false}
				onRevoke={() => {}}
			/>,
		);
		expect(markup).toContain("Read only");
		expect(markup).toContain("Read and write");
		expect(markup).toContain("Active");
		expect(markup).toContain("Expired");
		expect(markup).toContain("Revoked");
		expect(markup).toContain("…abcd");
		expect(markup).toContain("&lt;script&gt;client&lt;/script&gt;");
		expect(markup).not.toContain("<script>");
		expect(markup).not.toContain("ditero_pat_");
		expect(markup.match(/<button/g)).toHaveLength(2);
		expect(markup).not.toContain('aria-label="Revoke &quot;Revoked client');
	});

	test("pending operations disable revocation", () => {
		const markup = renderToStaticMarkup(
			<PersonalAccessTokenRows tokens={[token]} busy onRevoke={() => {}} />,
		);
		expect(markup).toContain('disabled=""');
	});

	test("a missing session shows a sign-in explanation and does not request tokens", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const markup = renderToStaticMarkup(<PersonalAccessTokensPanel />);
		expect(markup).toContain("Sign in again to manage access tokens.");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("token management requests", () => {
	test("always uses the current browser session and bypasses caching", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				Response.json({ version: 1, data: { id: token.id }, nextCursor: null }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const controller = new AbortController();
		expect(
			await requestPersonalAccessTokens(
				`/${token.id}`,
				z.object({ id: z.uuid() }),
				{
					method: "DELETE",
					signal: controller.signal,
					credentials: "omit",
					cache: "force-cache",
				},
			),
		).toEqual({ id: token.id });
		expect(fetchMock).toHaveBeenCalledWith(
			`/api/personal-access-tokens/${token.id}`,
			{
				method: "DELETE",
				signal: controller.signal,
				credentials: "include",
				cache: "no-store",
			},
		);
	});

	test.each([
		{ version: 2, data: { id: token.id }, nextCursor: null },
		{ version: 1, data: { id: "not-an-id" }, nextCursor: null },
		{ version: 1, data: { id: token.id }, nextCursor: "unexpected-cursor" },
	])("rejects an invalid successful envelope %#", async (body) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
		await expect(
			requestPersonalAccessTokens("", z.object({ id: z.uuid() }), {}),
		).rejects.toBeInstanceOf(z.ZodError);
	});

	test.each([
		["unauthorized", "Sign in again to manage access tokens."],
		[
			"token-limit",
			"You already have 20 active tokens. Revoke one before creating another.",
		],
		[
			"invalid-token-request",
			"Use a name of 1-80 characters and a lifetime of 1-365 days.",
		],
		["rate-limited", "The server is busy. Wait a moment and try again."],
		[
			"temporarily-unavailable",
			"The server is busy. Wait a moment and try again.",
		],
		["not-found", "This token no longer exists. Refresh the list."],
		[
			"unknown-code",
			"Could not complete the request. Check your connection and try again.",
		],
	])("explains %s without rendering server details", async (code, expected) => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					Response.json(
						{ code, title: "private server details" },
						{ status: 400 },
					),
				),
		);
		const failure = await requestPersonalAccessTokens(
			"",
			z.unknown(),
			{},
		).catch((error: unknown) => error);
		expect(tokenErrorMessage(failure)).toBe(expected);
	});

	test("a non-JSON session rejection still shows the sign-in explanation", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("expired", { status: 401 })),
		);
		const failure = await requestPersonalAccessTokens(
			"",
			z.unknown(),
			{},
		).catch((error: unknown) => error);
		expect(tokenErrorMessage(failure)).toBe(
			"Sign in again to manage access tokens.",
		);
	});
});
