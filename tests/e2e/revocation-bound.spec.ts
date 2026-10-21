import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { encodeSecProtocols } from "../../node_modules/@rocicorp/zero/out/zero-protocol/src/connect.js";
import { clientSchemaFrom } from "../../node_modules/@rocicorp/zero/out/zero-schema/src/builder/schema-builder.js";
import { schema } from "../../src/zero/schema.gen.ts";
import { configuredOrigin, uniqueEmail, webOrigin } from "./helpers.ts";

for (const kind of ["browser", "native"] as const) {
	test(`${kind} revocation closes an already authorized Zero subscription within the shipped interval`, async ({
		request,
		playwright,
	}) => {
		test.setTimeout(90_000);
		const origin = webOrigin();
		const email = uniqueEmail("revocation");
		const signup = await request.post("/api/auth/sign-up/email", {
			headers: { Origin: origin },
			data: {
				email,
				password: "pw-123456",
				name: "Revocation test",
			},
		});
		expect(signup.status()).toBe(200);
		const signedIn = await request.post("/api/auth/sign-in/email", {
			headers: { Origin: origin },
			data: { email, password: "pw-123456" },
		});
		expect(signedIn.status()).toBe(200);
		const { user } = (await signedIn.json()) as { user: { id: string } };
		// Native endpoints deliberately refuse ambient browser credentials.
		const native = await playwright.request.newContext({
			baseURL: configuredOrigin("E2E_API_URL"),
		});
		let credential = "";
		let socket: WebSocket | undefined;
		try {
			if (kind === "native") {
				const verifier = randomBytes(32).toString("base64url");
				const grant = await native.post("/api/native/grants", {
					data: {
						challenge: createHash("sha256")
							.update(verifier)
							.digest("base64url"),
						deviceLabel: "Revocation test",
					},
				});
				expect(grant.status()).toBe(200);
				const { grantId } = (await grant.json()) as { grantId: string };
				expect(
					(
						await request.post("/api/native/grants/approve", {
							headers: { Origin: origin },
							data: { grantId },
						})
					).status(),
				).toBe(200);
				const exchange = await native.post("/api/native/grants/exchange", {
					data: { grantId, verifier },
				});
				expect(exchange.status()).toBe(200);
				credential = ((await exchange.json()) as { token: string }).token;
			}
			const response =
				kind === "browser"
					? await request.get("/api/auth/token")
					: await native.get("/api/native/token", {
							headers: { Authorization: `Bearer ${credential}` },
						});
			expect(response.status()).toBe(200);
			const { token } = (await response.json()) as { token: string };
			const clientID = randomUUID();
			const url = new URL(
				"/sync/v51/connect",
				configuredOrigin("E2E_PUBLIC_ZERO_URL"),
			);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			for (const [name, value] of Object.entries({
				clientID,
				clientGroupID: randomUUID(),
				userID: user.id,
				baseCookie: "",
				ts: String(Date.now()),
				lmid: "0",
				wsid: randomUUID(),
				profileID: randomUUID(),
			}))
				url.searchParams.set(name, value);
			socket = new WebSocket(url, encodeSecProtocols(undefined, token));
			const connection = socket;
			let receivedWorkspace = false;
			let closed = false;
			connection.onclose = () => {
				closed = true;
			};
			connection.onmessage = (event) => {
				const [name, body] = JSON.parse(String(event.data)) as [
					string,
					{
						rowsPatch?: { op: string; tableName: string }[];
					},
				];
				if (name === "connected")
					connection.send(
						JSON.stringify([
							"initConnection",
							{
								desiredQueriesPatch: [
									{
										op: "put",
										hash: randomUUID(),
										name: "workspaces.mine",
										args: [{}],
									},
								],
								clientSchema: clientSchemaFrom(schema).clientSchema,
								activeClients: [clientID],
							},
						]),
					);
				if (name === "ping") connection.send(JSON.stringify(["pong", {}]));
				if (
					name === "pokePart" &&
					body.rowsPatch?.some(
						(row) => row.op === "put" && row.tableName === "workspace",
					)
				)
					receivedWorkspace = true;
			};
			await expect
				.poll(() => receivedWorkspace, { timeout: 20_000 })
				.toBe(true);
			expect(closed).toBe(false);
			const revoked =
				kind === "browser"
					? await request.post("/api/auth/sign-out", {
							headers: { Origin: origin },
							data: {},
						})
					: await native.post("/api/native/session/revoke", {
							headers: { Authorization: `Bearer ${credential}` },
							data: {},
						});
			expect(revoked.status()).toBe(200);
			const query = await native.post("/api/zero/query", {
				headers: { Authorization: `Bearer ${token}` },
				data: [
					"transform",
					[{ id: randomUUID(), name: "workspaces.mine", args: [{}] }],
				],
			});
			expect(query.status()).toBe(401);
			// Send no new query or auth update: only the server's periodic check
			// can close this otherwise healthy subscription. The old 300s default fails.
			await expect.poll(() => closed, { timeout: 45_000 }).toBe(true);
		} finally {
			socket?.close();
			await native.dispose();
		}
	});
}
