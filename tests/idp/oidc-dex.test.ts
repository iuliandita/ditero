import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	BASE,
	finishOAuth,
	memoryAuth,
	startOAuth,
} from "../support/oauth-mocks.ts";

// A real OpenID Connect provider (Dex) in a container, pinned by digest, on a
// loopback port. No mocked endpoint: discovery, JWKS, PKCE, nonce, signatures
// and the token exchange all run against the real server.
// Run: bunx vitest run tests/idp/oidc-dex.test.ts
const IMAGE =
	"ghcr.io/dexidp/dex@sha256:8499afd690c437f52301efd2b05b2455da5bd2dfc20332cd697dc9937f808462";
const PASSWORD = "dex-fixture-password";
const PASSWORD_HASH =
	"$2a$10$beJx2NbGPz2IECdjhvNrTuJT5A8RVNBH89cDAKZQu.pP1o0ri63ki";
const CLIENT_SECRET = randomBytes(18).toString("hex");
const CONTAINER = `ditero-oidc-dex-${randomBytes(4).toString("hex")}`;
const work = mkdtempSync(join(tmpdir(), "ditero-dex-"));

let issuer = "";
let port = 0;

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() =>
				typeof address === "object" && address
					? resolve(address.port)
					: reject(new Error("no port")),
			);
		});
	});
}

function docker(...args: string[]) {
	const result = spawnSync("docker", args, { encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(`docker ${args[0]} failed: ${result.stderr}`);
	return result.stdout;
}

beforeAll(async () => {
	port = await freePort();
	issuer = `http://127.0.0.1:${port}/dex`;
	mkdirSync(work, { recursive: true });
	const config = [
		`issuer: ${issuer}`,
		"storage: { type: memory }",
		"web: { http: 0.0.0.0:5556 }",
		"oauth2: { skipApprovalScreen: true }",
		"enablePasswordDB: true",
		"staticClients:",
		"  - id: ditero",
		"    name: Ditero",
		`    secret: ${CLIENT_SECRET}`,
		"    redirectURIs: [ 'http://localhost:3000/api/auth/callback/dex' ]",
		"staticPasswords:",
		...["alice", "bob"].flatMap((name, index) => [
			`  - email: ${name}@example.test`,
			`    hash: '${PASSWORD_HASH}'`,
			`    username: ${name}`,
			`    userID: 00000000-0000-4000-8000-00000000000${index + 1}`,
		]),
	].join("\n");
	// The container user is not ours: the fixture (a throwaway client secret on
	// loopback) must be world-readable.
	chmodSync(work, 0o755);
	writeFileSync(join(work, "config.yaml"), config, { mode: 0o644 });
	docker(
		"run",
		"--detach",
		"--name",
		CONTAINER,
		"--publish",
		`127.0.0.1:${port}:5556`,
		"--volume",
		`${join(work, "config.yaml")}:/etc/dex/config.yaml:ro`,
		IMAGE,
		"dex",
		"serve",
		"/etc/dex/config.yaml",
	);
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			const response = await fetch(
				`${issuer}/.well-known/openid-configuration`,
			);
			if (response.ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`Dex did not become ready: ${docker("logs", CONTAINER)}`);
}, 60_000);

afterAll(() => {
	spawnSync("docker", ["rm", "--force", CONTAINER]);
	rmSync(work, { recursive: true, force: true });
});

function env(overrides: Record<string, string> = {}) {
	return {
		DITERO_OIDC_PROVIDERS: "dex",
		DITERO_OIDC_DEX_ISSUER: issuer,
		DITERO_OIDC_DEX_CLIENT_ID: "ditero",
		DITERO_OIDC_DEX_CLIENT_SECRET: CLIENT_SECRET,
		DITERO_OIDC_DEX_NAME: "Dex",
		...overrides,
	};
}

// Plays the browser: follow Dex's redirects, submit its login form, and stop
// at the redirect back to Ditero.
async function loginAtDex(
	authorization: URL,
	login: string,
	password: string,
): Promise<URL | null> {
	let url = authorization.href;
	for (let hop = 0; hop < 12; hop++) {
		const response = await fetch(url, { redirect: "manual" });
		if (response.status >= 300 && response.status < 400) {
			const next = new URL(response.headers.get("location") ?? "", url);
			if (next.origin === new URL(BASE).origin) return next;
			url = next.href;
			continue;
		}
		const html = await response.text();
		const action = /<form[^>]*action="([^"]+)"/.exec(html)?.[1];
		if (!action) return null;
		const submit = await fetch(new URL(action.replaceAll("&amp;", "&"), url), {
			method: "POST",
			redirect: "manual",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ login, password }),
		});
		if (submit.status < 300 || submit.status >= 400) return null;
		const next = new URL(submit.headers.get("location") ?? "", url);
		if (next.origin === new URL(BASE).origin) return next;
		url = next.href;
	}
	return null;
}

async function journey(
	built: ReturnType<typeof memoryAuth>,
	who: string,
	password = PASSWORD,
) {
	const started = await startOAuth(built.auth, "dex");
	const back = await loginAtDex(
		started.authorization,
		`${who}@example.test`,
		password,
	);
	if (!back) return { started, outcome: null, back };
	const outcome = await finishOAuth(built.auth, "dex", started, {
		code: back.searchParams.get("code") ?? "",
		extra: {},
	}).catch((error: Error) => error);
	return { started, outcome, back };
}

describe("generic OIDC against a real Dex container", () => {
	test("authorization code + S256 PKCE + state + nonce, real discovery and signatures", async () => {
		const built = memoryAuth({ env: env() });
		const { started, back } = await journey(built, "alice");
		const query = started.authorization.searchParams;
		expect(started.authorization.href.startsWith(`${issuer}/auth`)).toBe(true);
		expect(query.get("code_challenge_method")).toBe("S256");
		expect(query.get("nonce")).toBeTruthy();
		expect(back?.searchParams.get("state")).toBe(started.state);
		expect(built.store.user).toHaveLength(1);
		expect(built.store.user[0]).toMatchObject({
			email: "alice@example.test",
			emailVerified: true,
		});
		expect(built.store.account).toHaveLength(1);
		expect(built.store.account[0]).toMatchObject({ providerId: "dex" });
		expect(String(built.store.account[0].accountId)).toMatch(
			new RegExp(`^${issuer.replaceAll(".", "\\.")}#.+`),
		);
		expect(built.store.session).toHaveLength(1);
	});

	test("a second sign-in resolves to the same account by issuer and subject", async () => {
		const built = memoryAuth({ env: env() });
		await journey(built, "alice");
		await journey(built, "alice");
		expect(built.store.user).toHaveLength(1);
		expect(built.store.account).toHaveLength(1);
		expect(built.store.session).toHaveLength(2);
	});

	test("two Dex users are two accounts", async () => {
		const built = memoryAuth({ env: env() });
		await journey(built, "alice");
		await journey(built, "bob");
		expect(built.store.user).toHaveLength(2);
		expect(new Set(built.store.account.map((a) => a.accountId)).size).toBe(2);
	});

	test("a wrong password never reaches Ditero", async () => {
		const built = memoryAuth({ env: env() });
		const { back } = await journey(built, "alice", "not-the-password");
		expect(back).toBeNull();
		expect(built.store.user).toHaveLength(0);
	});

	test("an authorization code cannot be replayed", async () => {
		const built = memoryAuth({ env: env() });
		const first = await journey(built, "alice");
		const code = first.back?.searchParams.get("code") ?? "";
		const replay = await finishOAuth(built.auth, "dex", first.started, {
			code,
		});
		expect(replay.error).not.toBeNull();
		expect(built.store.session).toHaveLength(1);
	});

	test("a callback carrying another request's state is refused", async () => {
		const built = memoryAuth({ env: env() });
		const one = await startOAuth(built.auth, "dex");
		const two = await startOAuth(built.auth, "dex");
		const back = await loginAtDex(
			one.authorization,
			"alice@example.test",
			PASSWORD,
		);
		const outcome = await finishOAuth(
			built.auth,
			"dex",
			{ ...one, state: two.state },
			{ code: back?.searchParams.get("code") ?? "" },
		);
		expect(outcome.error).not.toBeNull();
		expect(built.store.user).toHaveLength(0);
	});

	test("an issuer that does not match the one Dex reports is refused", async () => {
		const built = memoryAuth({
			env: env({ DITERO_OIDC_DEX_ISSUER: `${issuer}/` }),
		});
		const { outcome } = await journey(built, "alice");
		expect(outcome).toMatchObject({ error: "unable_to_get_user_info" });
		expect(built.store.user).toHaveLength(0);
		expect(built.store.session).toHaveLength(0);
	});

	test("a client secret Dex does not know is refused at the token exchange", async () => {
		const built = memoryAuth({
			env: env({ DITERO_OIDC_DEX_CLIENT_SECRET: "wrong-secret" }),
		});
		const { started, back, outcome } = await journey(built, "alice");
		expect(started.authorization.searchParams.get("client_id")).toBe("ditero");
		expect(back).not.toBeNull();
		expect(outcome).toMatchObject({ error: "invalid_code" });
		expect(built.store.user).toHaveLength(0);
	});
});
