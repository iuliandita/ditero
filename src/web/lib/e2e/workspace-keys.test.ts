import { describe, expect, it, vi } from "vitest";
import {
	generateIdentityKeyPair,
	importRecipientPublicKey,
	publicKeyFingerprint,
	sealWdk,
} from "../../../domain/e2e/hpke.ts";
import { commitWdk } from "../../../domain/e2e/wdk-commitment.ts";
import { encodeBytes } from "../../../domain/e2e/wire.ts";
import { loadWorkspaceKeys, reconcileWorkspaceKeys } from "./workspace-keys.ts";

const WORKSPACE = "ws_load";
const USER = "user_load";
const WDK = new Uint8Array(32).map((_, index) => (index * 23 + 9) & 0xff);

async function fixture() {
	const identity = await generateIdentityKeyPair();
	const publicKey = encodeBytes(identity.publicKey);
	const sealed = await sealWdk(
		WDK,
		await importRecipientPublicKey(identity.publicKey),
		{
			workspaceId: WORKSPACE,
			keyVersion: 1,
			recipientUserId: USER,
			recipientFingerprint: await publicKeyFingerprint(identity.publicKey),
		},
	);
	return {
		identity,
		publicKey,
		row: {
			membershipKeyId: "mk_1",
			workspaceId: WORKSPACE,
			keyVersion: 1,
			enc: encodeBytes(sealed.enc),
			ciphertext: encodeBytes(sealed.ciphertext),
			recipientPublicKey: publicKey,
			commitment: await commitWdk(WDK, WORKSPACE, 1),
			active: true,
			requestId: "kgr_1",
		},
	};
}

describe("loadWorkspaceKeys", () => {
	it("opens, verifies, and caches the caller's WDK", async () => {
		const { identity, publicKey, row } = await fixture();
		const putWdk = vi.fn();
		const fetcher = vi.fn(
			async () =>
				new Response(JSON.stringify({ keys: [row] }), { status: 200 }),
		);

		const result = await loadWorkspaceKeys(
			{
				privateKey: () => identity.privateKey,
				putWdk,
			},
			USER,
			publicKey,
			fetcher,
		);

		expect(result).toEqual({ loaded: [row], failed: [] });
		expect(putWdk).toHaveBeenCalledWith(WORKSPACE, 1, WDK);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("refuses a substituted key and marks its request failed", async () => {
		const { identity, publicKey, row } = await fixture();
		const putWdk = vi.fn();
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input) === "/api/e2e/keys/mine") {
				return new Response(
					JSON.stringify({
						keys: [
							{
								...row,
								commitment: await commitWdk(new Uint8Array(32), WORKSPACE, 1),
							},
						],
					}),
					{ status: 200 },
				);
			}
			return new Response(null, { status: 200 });
		});

		const result = await loadWorkspaceKeys(
			{
				privateKey: () => identity.privateKey,
				putWdk,
			},
			USER,
			publicKey,
			fetcher,
		);

		expect(result.loaded).toEqual([]);
		expect(result.failed).toEqual([{ workspaceId: WORKSPACE, keyVersion: 1 }]);
		expect(putWdk).not.toHaveBeenCalled();
		expect(fetcher).toHaveBeenNthCalledWith(
			2,
			"/api/e2e/grants/fail",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					requestId: "kgr_1",
					reason: "recipient could not verify workspace key",
				}),
			}),
		);
	});

	it("does not accept a wrap addressed to a different identity", async () => {
		const { identity, publicKey, row } = await fixture();
		const other = await generateIdentityKeyPair();
		const putWdk = vi.fn();
		const fetcher = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						keys: [
							{ ...row, recipientPublicKey: encodeBytes(other.publicKey) },
						],
					}),
					{ status: 200 },
				),
		);

		const result = await loadWorkspaceKeys(
			{ privateKey: () => identity.privateKey, putWdk },
			USER,
			publicKey,
			fetcher,
		);
		expect(result.loaded).toEqual([]);
		expect(result.failed).toHaveLength(1);
		expect(putWdk).not.toHaveBeenCalled();
	});

	it("does not mark a newer commitment format as a failed grant", async () => {
		const { identity, publicKey, row } = await fixture();
		const fetcher = vi.fn(async () =>
			Response.json({
				keys: [{ ...row, commitment: `2.${"0".repeat(64)}` }],
			}),
		);
		const result = await loadWorkspaceKeys(
			{ privateKey: () => identity.privateKey, putWdk: vi.fn() },
			USER,
			publicKey,
			fetcher,
		);
		expect(result.failed).toHaveLength(1);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});

describe("reconcileWorkspaceKeys", () => {
	it("provisions every keyless workspace after enrollment", async () => {
		const identity = await generateIdentityKeyPair();
		const publicKey = encodeBytes(identity.publicKey);
		const cached = new Map<string, Uint8Array>();
		let provisionBody: Record<string, unknown> | null = null;
		const fetcher = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				switch (String(input)) {
					case "/api/e2e/keys/mine":
						return Response.json({ keys: [] });
					case "/api/e2e/provision/pending":
						return Response.json({
							workspaces: [
								{
									id: WORKSPACE,
									version: 1,
									reason: "no-key",
									commitment: null,
								},
							],
						});
					case "/api/e2e/provision":
						provisionBody = JSON.parse(String(init?.body));
						return Response.json({
							workspaceId: WORKSPACE,
							version: 1,
							outcome: "minted",
						});
					case "/api/e2e/grants/pending":
						return Response.json({ requests: [] });
					default:
						throw new Error(`unexpected request ${String(input)}`);
				}
			},
		);

		const rows = await reconcileWorkspaceKeys(
			{
				privateKey: () => identity.privateKey,
				putWdk: (workspaceId, version, wdk) =>
					cached.set(`${workspaceId}:${version}`, wdk),
				wdkFor: (workspaceId, version) =>
					cached.get(`${workspaceId}:${version}`),
			},
			USER,
			publicKey,
			fetcher,
		);

		expect(provisionBody).toMatchObject({ workspaceId: WORKSPACE });
		expect(cached.get(`${WORKSPACE}:1`)).toHaveLength(32);
		expect(rows).toEqual([
			expect.objectContaining({
				workspaceId: WORKSPACE,
				keyVersion: 1,
				active: true,
			}),
		]);
	});

	it("requests an existing key instead of minting a fork", async () => {
		const identity = await generateIdentityKeyPair();
		const publicKey = encodeBytes(identity.publicKey);
		const called: string[] = [];
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			called.push(String(input));
			if (String(input) === "/api/e2e/keys/mine") {
				return Response.json({ keys: [] });
			}
			if (String(input) === "/api/e2e/provision/pending") {
				return Response.json({
					workspaces: [
						{
							id: WORKSPACE,
							version: 1,
							reason: "no-grant",
							commitment: await commitWdk(WDK, WORKSPACE, 1),
						},
					],
				});
			}
			if (String(input) === "/api/e2e/grants/request") {
				return Response.json({
					requestId: "kgr_1",
					keyVersion: 1,
					state: "pending",
				});
			}
			if (String(input) === "/api/e2e/grants/pending") {
				return Response.json({ requests: [] });
			}
			throw new Error(`unexpected request ${String(input)}`);
		});

		await reconcileWorkspaceKeys(
			{
				privateKey: () => identity.privateKey,
				putWdk: vi.fn(),
				wdkFor: () => undefined,
			},
			USER,
			publicKey,
			fetcher,
		);
		expect(called).toContain("/api/e2e/grants/request");
		expect(called).not.toContain("/api/e2e/provision");
	});
});
