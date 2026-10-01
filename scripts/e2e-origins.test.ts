import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	configuredOrigin,
	validateOrigin,
	webOrigin,
} from "../tests/e2e/helpers.ts";

const project = vi.hoisted(() => ({
	baseURL: "https://app.example.test:45173",
}));
vi.mock("@playwright/test", async (original) => ({
	...(await original<typeof import("@playwright/test")>()),
	test: { info: () => ({ project: { use: project } }) },
}));
afterEach(() => vi.unstubAllEnvs());

// Exceptions must name the exact security fixture and its literal. Deployment
// URLs never belong here. Current specs need no loopback security exceptions.
const reviewedSecurityOrigins: Readonly<Record<string, ReadonlySet<string>>> =
	{};
function hardcodedOrigins(
	source: string,
	allowed: ReadonlySet<string> = new Set(),
): string[] {
	const file = ts.createSourceFile(
		"spec.ts",
		source,
		ts.ScriptTarget.Latest,
		true,
	);
	const found: string[] = [];
	function visit(node: ts.Node) {
		if (
			(ts.isStringLiteralLike(node) ||
				ts.isTemplateHead(node) ||
				ts.isTemplateMiddle(node) ||
				ts.isTemplateTail(node)) &&
			/(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|\[::1\]):/i.test(
				node.text,
			) &&
			!allowed.has(node.text)
		)
			found.push(node.text);
		ts.forEachChild(node, visit);
	}
	visit(file);
	return found;
}

describe("E2E deployment origins", () => {
	test("specs contain no unreviewed hardcoded loopback deployment origin", () => {
		const directory = new URL("../tests/e2e/", import.meta.url);
		const violations = readdirSync(directory, { recursive: true })
			.filter((name) => typeof name === "string" && name.endsWith(".spec.ts"))
			.flatMap((name) => {
				const path = String(name);
				return hardcodedOrigins(
					readFileSync(join(fileURLToPath(directory), path), "utf8"),
					reviewedSecurityOrigins[path],
				).map((origin) => `${path}: ${origin}`);
			});
		expect(violations).toEqual([]);
	});
	test("the guard detects literal and interpolated origins while preserving reviewed security inputs and comments", () => {
		const interpolation = "$" + "{port}";
		const source = `// http://localhost:3000 is documentation\nconst api = "http://localhost:43100/api"; const ws = \`ws://127.0.0.1:${interpolation}/sync\`; const attack = "http://[::1]:9999/";`;
		expect(hardcodedOrigins(source, new Set(["http://[::1]:9999/"]))).toEqual([
			"http://localhost:43100/api",
			"ws://127.0.0.1:",
		]);
		expect(hardcodedOrigins('const api = "http://localhost:3000"')).toEqual([
			"http://localhost:3000",
		]);
		const prefix = "$" + "{prefix}";
		const suffix = "$" + "{suffix}";
		const fragments = `const middle = \`${prefix}http://localhost:43000${suffix}\`; const tail = \`${prefix}http://127.0.0.1:43001\`; const attack = \`${prefix}http://[::1]:9999/\`;`;
		expect(hardcodedOrigins(fragments)).toEqual([
			"http://localhost:43000",
			"http://127.0.0.1:43001",
			"http://[::1]:9999/",
		]);
		expect(
			hardcodedOrigins(fragments, new Set(["http://[::1]:9999/"])),
		).toEqual(["http://localhost:43000", "http://127.0.0.1:43001"]);
		expect(
			hardcodedOrigins(fragments, new Set(["http://localhost:43000"])),
		).toEqual(["http://127.0.0.1:43001", "http://[::1]:9999/"]);
	});
	test("web requests use the current project's alternate origin", () => {
		expect(webOrigin()).toBe("https://app.example.test:45173");
	});
	test.each([
		"E2E_API_URL",
		"E2E_MAIL_API_URL",
		"E2E_SMTP_HTTP_URL",
		"E2E_PUBLIC_ZERO_URL",
		"E2E_NTFY_URL",
	] as const)("%s requires an explicit origin and retains alternate ports", (name) => {
		vi.stubEnv(name, "");
		expect(() => configuredOrigin(name)).toThrow("configured HTTP origin");
		vi.stubEnv(name, "http://127.0.0.1:43199/");
		expect(configuredOrigin(name)).toBe("http://127.0.0.1:43199");
	});
	test.each([
		undefined,
		"",
		"not a URL",
		"ftp://example.test",
		"https://user:secret@example.test",
		"https://example.test/api",
		"https://example.test?key=secret",
		"https://example.test/#fragment",
	])("rejects invalid configuration without echoing its value", (value) => {
		expect(() => validateOrigin(value, "fixture origin")).toThrow(
			/fixture origin requires/,
		);
	});
});
