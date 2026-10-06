import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = process.cwd();
const roots = [
	"tests/e2e/account-setup-browser.tsx",
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
function pins(paths: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	function visit(path: string) {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink())
			throw new Error("Compiled input symlink refused");
		if (stat.isDirectory())
			for (const name of readdirSync(path).sort()) visit(join(path, name));
		else if (stat.isFile())
			out[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
		else throw new Error("Unsupported compiled input");
	}
	for (const path of paths) visit(path);
	return out;
}
function ownedDirectory(value: string | undefined): string {
	if (
		!value ||
		resolve(value) !== value ||
		!value.startsWith(join(tmpdir(), "ditero-e2e-web-")) ||
		value.slice(join(tmpdir(), "ditero-e2e-web-").length).includes("/")
	)
		throw new Error("Owned compiled output required");
	const s = lstatSync(value);
	if (
		!s.isDirectory() ||
		s.isSymbolicLink() ||
		s.uid !== process.getuid?.() ||
		(s.mode & 0o777) !== 0o700
	)
		throw new Error("Compiled output ownership mismatch");
	return value;
}
function directoryIdentity(value: string) {
	ownedDirectory(value);
	const stat = lstatSync(value);
	return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
}
function removeAllocated(
	value: string,
	expected: ReturnType<typeof directoryIdentity>,
) {
	const actual = directoryIdentity(value);
	if (
		actual.dev !== expected.dev ||
		actual.ino !== expected.ino ||
		actual.uid !== expected.uid
	)
		throw new Error("Compiled output identity changed; retained");
	rmSync(value, { recursive: true });
}
function readBinding(dir: string): string {
	const path = join(dir, "binding.json");
	const before = lstatSync(path);
	if (
		!before.isFile() ||
		before.isSymbolicLink() ||
		before.uid !== process.getuid?.() ||
		(before.mode & 0o777) !== 0o600 ||
		before.size > 16 * 1024 * 1024
	)
		throw new Error("Compiled binding metadata refused");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = fstatSync(fd);
		if (
			opened.dev !== before.dev ||
			opened.ino !== before.ino ||
			opened.uid !== before.uid ||
			opened.mode !== before.mode ||
			opened.size !== before.size ||
			opened.mtimeMs !== before.mtimeMs
		)
			throw new Error("Compiled binding open identity changed");
		const raw = readFileSync(fd, "utf8");
		const after = fstatSync(fd);
		if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
			throw new Error("Compiled binding read identity changed");
		return raw;
	} finally {
		closeSync(fd);
	}
}
export function validateCompiledWeb(
	value = process.env.E2E_COMPILED_WEB_DIR,
): string {
	const dir = ownedDirectory(value);
	const m = JSON.parse(readBinding(dir));
	if (
		m.purpose !== "ditero-e2e-compiled" ||
		m.root !== ROOT ||
		m.mode !== "test" ||
		m.uid !== process.getuid?.() ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
			m.marker,
		)
	)
		throw new Error("Compiled binding refused");
	if (
		JSON.stringify(m.source) !==
			JSON.stringify(pins(roots.map((p) => join(ROOT, p)))) ||
		JSON.stringify(m.dist) !== JSON.stringify(pins([join(dir, "dist")]))
	)
		throw new Error("Compiled source/output changed");
	return join(dir, "dist");
}
if (import.meta.main) {
	const action = process.argv[2];
	if (action === "build") {
		const dir = mkdtempSync(join(tmpdir(), "ditero-e2e-web-"));
		const allocated = directoryIdentity(dir);
		let complete = false;
		let failure: unknown;
		let cleanupFailure: unknown;
		let failed = false;
		let cleanupFailed = false;
		try {
			for (const args of [
				["run", "i18n:compile"],
				["x", "vite", "build", "--mode", "test", "--outDir", join(dir, "dist")],
			]) {
				const result = spawnSync("bun", args, {
					stdio: "inherit",
					env: { ...process.env, NODE_ENV: "production" },
					timeout: 300000,
				});
				if (result.status !== 0 || result.error)
					throw new Error("Compiled fixture preparation failed");
			}
			writeFileSync(
				join(dir, "binding.json"),
				JSON.stringify({
					purpose: "ditero-e2e-compiled",
					marker: randomUUID(),
					uid: process.getuid?.(),
					root: ROOT,
					mode: "test",
					source: pins(roots.map((p) => join(ROOT, p))),
					dist: pins([join(dir, "dist")]),
				}),
				{ flag: "wx", mode: 0o600 },
			);
			validateCompiledWeb(dir);
			if (process.env.GITHUB_ENV)
				writeFileSync(process.env.GITHUB_ENV, `E2E_COMPILED_WEB_DIR=${dir}\n`, {
					flag: "a",
				});
			console.log(JSON.stringify({ compiledDirectory: dir, mode: "test" }));
			complete = true;
		} catch (error) {
			failure = error;
			failed = true;
		} finally {
			if (!complete) {
				try {
					removeAllocated(dir, allocated);
				} catch (cleanup) {
					cleanupFailure = cleanup;
					cleanupFailed = true;
				}
			}
		}
		if (failed) {
			if (cleanupFailed)
				throw new AggregateError(
					[failure, cleanupFailure],
					"Compiled build failed; cleanup refused and output retained",
					{ cause: failure },
				);
			throw failure;
		}
		if (cleanupFailed) throw cleanupFailure;
	} else if (action === "validate") validateCompiledWeb();
	else if (action === "cleanup") {
		const dir = ownedDirectory(process.env.E2E_COMPILED_WEB_DIR);
		const allocated = directoryIdentity(dir);
		validateCompiledWeb(dir);
		removeAllocated(dir, allocated);
	} else throw new Error("Expected build, validate or cleanup");
}
