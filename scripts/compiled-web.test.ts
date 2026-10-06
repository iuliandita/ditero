import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";
import * as ts from "typescript";
import { test } from "vitest";

const nativeRequire = createRequire(import.meta.url);
const source = fs.readFileSync(
	fileURLToPath(new URL("../tests/e2e/compiled-web.ts", import.meta.url)),
	"utf8",
);
const root = "/fixture";
const output = "/tmp/ditero-e2e-web-ABC123";
const uid = 1000;
const roots = [
	"src",
	"messages",
	"public",
	"scripts",
	"project.inlang",
	"index.html",
	"package.json",
	"bun.lock",
	"vite.config.ts",
	"paraglide.options.ts",
	"tsconfig.json",
];
const hash = (x: string | Buffer) =>
	crypto.createHash("sha256").update(x).digest("hex");
type MutationState = {
	binding: Record<string, unknown>;
	files: Map<string, Buffer>;
	setSymlink: () => void;
	setForeign: () => void;
	setBindingUID: (value: number) => void;
	setBindingMode: (value: number) => void;
	setNonregular: () => void;
};
type Options = {
	action?: string;
	mutation?: (state: MutationState) => void;
	failBuild?: boolean;
	replaceAfterSpawn?: boolean;
	replaceIdentity?: boolean;
};
function make({
	action,
	mutation,
	failBuild = false,
	replaceAfterSpawn = false,
	replaceIdentity = false,
}: Options = {}) {
	const files = new Map(
		roots.map((x) => [`${root}/${x}`, Buffer.from(`source:${x}`)]),
	);
	files.set(`${output}/dist/index.html`, Buffer.from("compiled"));
	const hashFile = (name: string) => {
		const bytes = files.get(name);
		assert(bytes);
		return hash(bytes);
	};
	const binding: Record<string, unknown> = {
		purpose: "ditero-e2e-compiled",
		marker: "11111111-1111-4111-8111-111111111111",
		uid,
		root,
		mode: "test",
		source: Object.fromEntries(
			roots.map((x) => [`${root}/${x}`, hashFile(`${root}/${x}`)]),
		),
		dist: {
			[`${output}/dist/index.html`]: hashFile(`${output}/dist/index.html`),
		},
	};
	let bindingSymlink = false,
		owned = true;
	const calls: string[] = [];
	let directoryInode = 11;
	let bindingUID = uid,
		bindingMode = 0o600,
		regular = true;
	const metadata = () => ({
		uid: bindingUID,
		mode: bindingMode,
		dev: 1,
		ino: 22,
		size: JSON.stringify(binding).length,
		mtimeMs: 1,
		isFile: () => regular,
		isSymbolicLink: () => bindingSymlink,
	});
	const api = {
		mkdtempSync: () => {
			calls.push("allocate");
			return output;
		},
		lstatSync: (x: string) => {
			if (x === output)
				return {
					uid: owned ? uid : 2000,
					mode: 0o700,
					dev: 1,
					ino: directoryInode,
					isDirectory: () => true,
					isSymbolicLink: () => false,
				};
			if (x === `${output}/binding.json`) return metadata();
			if (x === `${output}/dist`)
				return { isDirectory: () => true, isSymbolicLink: () => false };
			if (files.has(x))
				return {
					isFile: () => true,
					isDirectory: () => false,
					isSymbolicLink: () => false,
				};
			throw Error(`unknown fake path ${x}`);
		},
		readdirSync: (x: string) => {
			assert.equal(x, `${output}/dist`);
			return ["index.html"];
		},
		constants: { O_RDONLY: 0, O_NOFOLLOW: 131072 },
		openSync: () => 101,
		fstatSync: () => metadata(),
		closeSync: () => {},
		readFileSync: (x: string | number, encoding?: string) => {
			if (x === 101 || x === `${output}/binding.json`)
				return JSON.stringify(binding);
			const b = files.get(String(x));
			assert(b);
			return encoding ? b.toString() : b;
		},
		writeFileSync: (x: string, data: string) => {
			calls.push(`write:${x}`);
			if (x === `${output}/binding.json`)
				Object.assign(binding, JSON.parse(data));
			else assert.equal(x, "/fake-github-env");
		},
		rmSync: (x: string, opts: { recursive: boolean }) => {
			calls.push("remove");
			assert.equal(x, output);
			assert.equal(opts.recursive, true);
			calls.push(owned ? "removed-owned" : "removed-foreign-replacement");
		},
	};
	if (mutation)
		mutation({
			binding,
			files,
			setSymlink: () => (bindingSymlink = true),
			setForeign: () => (owned = false),
			setBindingUID: (x: number) => (bindingUID = x),
			setBindingMode: (x: number) => (bindingMode = x),
			setNonregular: () => (regular = false),
		});
	const exports: { validateCompiledWeb?: (value: string) => string } = {};
	const processMock = {
		cwd: () => root,
		getuid: () => uid,
		env: { E2E_COMPILED_WEB_DIR: output, GITHUB_ENV: "/fake-github-env" },
		argv: ["bun", "compiled-web.ts", action],
	};
	const requireMock = (name: string): unknown =>
		name === "node:fs"
			? api
			: name === "node:os"
				? { tmpdir: () => "/tmp" }
				: name === "node:child_process"
					? {
							spawnSync: (_cmd: string, args: string[]) => {
								calls.push(`spawn:${args.join(" ")}`);
								if (replaceAfterSpawn) owned = false;
								if (replaceIdentity) directoryInode = 12;
								return { status: failBuild ? 1 : 0 };
							},
						}
					: nativeRequire(name);
	const js = ts.transpileModule(
		source.replace("import.meta.main", "__entryMain"),
		{
			compilerOptions: {
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2022,
			},
		},
	).outputText;
	let error: unknown = null;
	try {
		vm.runInNewContext(js, {
			require: requireMock,
			exports,
			process: processMock,
			__entryMain: !!action,
			console: { log: () => {} },
			Buffer,
		});
	} catch (e) {
		error = e;
	}
	const validate = exports.validateCompiledWeb;
	assert(validate);
	return { validate: () => validate(output), calls, error };
}

test("actual helper positive validates exact source and dist", () =>
	assert.equal(make().validate(), `${output}/dist`));
for (const field of ["purpose", "root", "mode", "uid", "marker"])
	test(`binding ${field} mismatch refuses`, () =>
		assert.throws(() =>
			make({
				mutation: ({ binding }) => (binding[field] = "invalid"),
			}).validate(),
		));
test("source drift refuses", () =>
	assert.throws(() =>
		make({
			mutation: ({ files }) => files.set(`${root}/src`, Buffer.from("changed")),
		}).validate(),
	));
test("dist drift refuses", () =>
	assert.throws(() =>
		make({
			mutation: ({ files }) =>
				files.set(`${output}/dist/index.html`, Buffer.from("changed")),
		}).validate(),
	));
test("foreign directory UID refuses", () =>
	assert.throws(() =>
		make({ mutation: ({ setForeign }) => setForeign() }).validate(),
	));
test("actual build dispatches i18n then Vite test mode once", () => {
	const x = make({ action: "build" });
	assert.equal(x.error, null);
	assert.deepEqual(
		x.calls.filter((c) => c.startsWith("spawn:")),
		[
			"spawn:run i18n:compile",
			`spawn:x vite build --mode test --outDir ${output}/dist`,
		],
	);
	assert(!x.calls.includes("remove"));
});
test("actual cleanup validates before removal", () => {
	const x = make({
		action: "cleanup",
		mutation: ({ files }) =>
			files.set(`${output}/dist/index.html`, Buffer.from("drift")),
	});
	assert(x.error);
	assert(!x.calls.includes("remove"));
});
// Regression controls exercise the authority checks and retained first failure.
test("symlink binding refuses", () =>
	assert.throws(() =>
		make({ mutation: ({ setSymlink }) => setSymlink() }).validate(),
	));
for (const [name, mutation] of [
	["foreign binding UID", ({ setBindingUID }) => setBindingUID(2000)],
	["binding exposed mode", ({ setBindingMode }) => setBindingMode(0o644)],
	["nonregular binding", ({ setNonregular }) => setNonregular()],
] as [string, (state: MutationState) => void][])
	test(`${name} refuses`, () =>
		assert.throws(() => make({ mutation }).validate()));
test("failed build retains replaced foreign directory and first failure", () => {
	const x = make({ action: "build", failBuild: true, replaceAfterSpawn: true });
	assert(x.error);
	assert(!x.calls.includes("remove"));
	assert.equal(
		(x.error as AggregateError).errors[0].message,
		"Compiled fixture preparation failed",
	);
});
test("failed build cleans same allocation", () => {
	const x = make({ action: "build", failBuild: true });
	assert(x.error);
	assert(x.calls.includes("removed-owned"));
});

test("failed build retains same-UID inode replacement", () => {
	const x = make({ action: "build", failBuild: true, replaceIdentity: true });
	assert(x.error);
	assert(!x.calls.includes("remove"));
	assert.equal(
		(x.error as AggregateError).errors[0].message,
		"Compiled fixture preparation failed",
	);
});

function actualViteConfig(mode: string) {
	const configSource = fs.readFileSync(
		fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
		"utf8",
	);
	const exports: {
		default?: (input: { mode: string }) => {
			build?: {
				rolldownOptions: {
					input: Record<string, string>;
					preserveEntrySignatures: string;
					output: { entryFileNames: (chunk: { name: string }) => string };
				};
			};
			plugins: {
				name?: string;
				configurePreviewServer?: (server: {
					middlewares: {
						use: (
							handler: (
								request: { url: string; method: string },
								response: {
									statusCode: number;
									setHeader: (name: string, value: string) => void;
									end: () => void;
								},
								next: () => void,
							) => void,
						) => void;
					};
				}) => void;
			}[];
		};
	} = {};
	const requireMock = (name: string): unknown => {
		if (name === "vite") return { defineConfig: (value: unknown) => value };
		if (name === "@inlang/paraglide-js")
			return { paraglideVitePlugin: () => ({}) };
		if (name === "@tailwindcss/vite" || name === "@vitejs/plugin-react")
			return { __esModule: true, default: () => ({}) };
		if (name === "./paraglide.options.ts") return { paraglideOptions: {} };
		if (name === "./scripts/e2e-signup-transport.ts")
			return { configureSignupTransport: () => {} };
		if (name === "./scripts/e2e-stack.ts")
			return { apiProxyTarget: () => "http://localhost:3000" };
		if (name === "./scripts/vendor-licenses.ts")
			return { vendorLicenses: () => ({}) };
		return nativeRequire(name);
	};
	const js = ts.transpileModule(
		configSource.replaceAll(
			"import.meta.url",
			'"file:///fixture/vite.config.ts"',
		),
		{
			compilerOptions: {
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2022,
			},
		},
	).outputText;
	vm.runInNewContext(js, {
		require: requireMock,
		exports,
		process: { env: {} },
		URL,
		Buffer,
	});
	assert(exports.default);
	return exports.default({ mode });
}
const expectedRawEntries = [
	["/src/web/lib/e2e/download.ts", "e2e-download"],
	["/src/web/lib/e2e/ciphertext-staging.ts", "e2e-ciphertext-staging"],
	["/src/web/lib/zero-lifecycle.ts", "e2e-zero-lifecycle"],
	["/tests/e2e/zero-close-browser.ts", "e2e-zero-close-browser"],
	["/src/web/dev/csp-gate.ts", "e2e-csp-gate"],
	["/src/domain/e2e/stream.ts", "e2e-stream"],
	["/src/domain/e2e/envelope.ts", "e2e-envelope"],
	["/src/domain/e2e/wire.ts", "e2e-wire"],
] as const;
test("actual Vite test build retains browser exports alongside the app", () => {
	const { build } = actualViteConfig("test");
	assert(build);
	assert.deepEqual(
		Object.keys(build.rolldownOptions.input).sort(),
		["index", ...expectedRawEntries.map((x) => x[1])].sort(),
	);
	assert.equal(build.rolldownOptions.preserveEntrySignatures, "strict");
	for (const [raw, name] of expectedRawEntries) {
		assert.equal(build.rolldownOptions.input[name], `/fixture${raw}`);
		assert.equal(
			build.rolldownOptions.output.entryFileNames({ name }),
			raw.slice(1),
		);
	}
	assert.equal(
		build.rolldownOptions.output.entryFileNames({ name: "index" }),
		"assets/[name]-[hash].js",
	);
});
test("actual test preview marks canonical compiled entries as JavaScript without rewriting", () => {
	const config = actualViteConfig("test");
	const middleware: ((
		request: { url: string; method: string },
		response: {
			statusCode: number;
			setHeader: (name: string, value: string) => void;
			end: () => void;
		},
		next: () => void,
	) => void)[] = [];
	config.plugins
		.find((x) => x.name === "e2e-compiled-module-entries")
		?.configurePreviewServer?.({
			middlewares: { use: (x) => middleware.push(x) },
		});
	assert.equal(middleware.length, 1);
	const handler = middleware[0];
	for (const [raw] of expectedRawEntries)
		for (const method of ["GET", "HEAD"]) {
			const request = { url: raw, method };
			let next = 0;
			const headers = new Map<string, string>();
			let ended = 0;
			const response = {
				statusCode: 200,
				setHeader: (key: string, value: string) => headers.set(key, value),
				end: () => {
					ended++;
				},
			};
			handler(request, response, () => next++);
			assert.equal(request.url, raw);
			assert.equal(response.statusCode, 200);
			assert.equal(
				headers.get("Content-Type"),
				"text/javascript; charset=utf-8",
			);
			assert.equal(headers.size, 1);
			assert.equal(headers.has("Location"), false);
			assert.equal(ended, 0);
			assert.equal(next, 1);
		}
	for (const url of [
		"/src/web/main.tsx",
		"/src/web/lib/e2e/download.ts?unknown=1",
		"/src/web/lib/e2e/../download.ts",
		"/src/web/lib/e2e/%64ownload.ts",
		"/__proto__",
	]) {
		const request = { url, method: "GET" };
		handler(
			request,
			{
				statusCode: 200,
				setHeader: () => assert.fail("Unexpected MIME change"),
				end: () => assert.fail("Unexpected response end"),
			},
			() => {},
		);
		assert.equal(request.url, url);
	}
	const request = { url: expectedRawEntries[0][0], method: "POST" };
	handler(
		request,
		{
			statusCode: 200,
			setHeader: () => assert.fail("Unexpected MIME change"),
			end: () => assert.fail("Unexpected response end"),
		},
		() => {},
	);
	assert.equal(request.url, expectedRawEntries[0][0]);
});
for (const mode of ["production", "development"])
	test(`actual ${mode} config never adds test entries or preview rewrites`, () => {
		const config = actualViteConfig(mode);
		assert.equal(config.build, undefined);
		let installed = 0;
		config.plugins
			.find((x) => x.name === "e2e-compiled-module-entries")
			?.configurePreviewServer?.({ middlewares: { use: () => installed++ } });
		assert.equal(installed, 0);
	});

function actualPlaywrightCommands(compiled: boolean) {
	const source = fs.readFileSync(
		fileURLToPath(new URL("../playwright.config.ts", import.meta.url)),
		"utf8",
	);
	const exports: { default?: { webServer: { command: string }[] } } = {};
	const requireMock = (name: string): unknown => {
		if (name === "@playwright/test")
			return { defineConfig: (value: unknown) => value, devices: {} };
		if (name === "./scripts/e2e-stack.ts")
			return {
				parsePort: Number,
				portOf: (value: string) => Number(new URL(value).port),
			};
		if (name === "./tests/e2e/compiled-web.ts")
			return { validateCompiledWeb: () => "/tmp/ditero-e2e-web-ABC123/dist" };
		if (name === "./tests/e2e/helpers.ts")
			return { validateOrigin: (value: string) => value };
		if (name === "./tests/support/private-host.ts")
			return { privateHost: () => "192.0.2.1" };
		throw new Error(`Unexpected configuration dependency: ${name}`);
	};
	const js = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
	vm.runInNewContext(js, {
		require: requireMock,
		exports,
		process: { env: compiled ? { E2E_BROWSER_MODE: "compiled" } : {} },
		Buffer,
		URL,
	});
	assert(exports.default);
	return exports.default.webServer.map((x) => x.command);
}
test("actual compiled preview selects test mode for the allowlisted built modules", () => {
	const commands = actualPlaywrightCommands(true);
	const preview = commands.filter((x) => x.includes("vite preview"));
	assert.equal(preview.length, 1);
	assert.equal(
		preview[0],
		"bun x vite preview --mode test --outDir /tmp/ditero-e2e-web-ABC123/dist --port 5173 --strictPort",
	);
});
test("ordinary browser source mode does not start a test preview", () => {
	const commands = actualPlaywrightCommands(false);
	assert.equal(
		commands.some((x) => x.includes("vite preview")),
		false,
	);
	assert.equal(commands.filter((x) => x.includes("dev:web")).length, 1);
});
