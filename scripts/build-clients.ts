import { createHash } from "node:crypto";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import release from "../release.json";

const root = resolve(import.meta.dir, "..");
const target = "bun-linux-x64";
const runtimeVersion = "1.4.2";
const runtimeArchiveSha256 =
	"36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913";

async function officialRuntime(output: string): Promise<string> {
	if (Bun.version !== runtimeVersion)
		throw new Error("Client builder and pinned runtime versions must match");
	const archive = join(output, "bun-linux-x64.zip");
	await mkdir(output, { recursive: true });
	if (!(await Bun.file(archive).exists())) {
		const response = await fetch(
			`https://github.com/oven-sh/bun/releases/download/bun-v${runtimeVersion}/bun-linux-x64.zip`,
		);
		if (!response.ok) throw new Error("Official Bun runtime download failed");
		await Bun.write(archive, response);
	}
	const digest = createHash("sha256")
		.update(new Uint8Array(await Bun.file(archive).arrayBuffer()))
		.digest("hex");
	if (digest !== runtimeArchiveSha256)
		throw new Error("Official Bun runtime checksum mismatch");
	const runtime = join(output, "bun");
	await command([
		"unzip",
		"-o",
		"-j",
		archive,
		"bun-linux-x64/bun",
		"-d",
		output,
	]);
	await chmod(runtime, 0o755);
	if (
		(await command([runtime, "--revision"], true)) !==
		`${runtimeVersion}+744846f84`
	)
		throw new Error("Official Bun runtime revision mismatch");
	return runtime;
}
const clients = {
	ditero: "src/cli/index.ts",
	"ditero-mcp": "src/mcp/index.ts",
	"ditero-tui": "src/tui/index.ts",
};

async function command(argv: string[], capture = false): Promise<string> {
	const child = Bun.spawn(argv, {
		cwd: root,
		stdout: capture ? "pipe" : "inherit",
		stderr: "inherit",
	});
	const result = capture ? await new Response(child.stdout).text() : "";
	if ((await child.exited) !== 0)
		throw new Error(`Client packaging command failed: ${argv[0]}`);
	return result.trim();
}

export function buildCpus(status: string): number[] {
	const value = /^Cpus_allowed_list:\s*(.+)$/m.exec(status)?.[1];
	if (!value) throw new Error("Cannot establish Linux build CPU affinity");
	const cpus = value.split(",").flatMap((range) => {
		const [first, last = first] = range.split("-").map(Number);
		if (
			!Number.isInteger(first) ||
			!Number.isInteger(last) ||
			first < 0 ||
			last < first ||
			last > 65535
		)
			throw new Error("Invalid CPU affinity");
		return Array.from(
			{ length: last - first + 1 },
			(_, index) => first + index,
		);
	});
	return cpus.slice(0, 4);
}

async function packageNotices(
	input: string,
	destination: string,
): Promise<string | null> {
	if (!input.includes("node_modules/")) return null;
	let directory = dirname(await realpath(resolve(root, input)));
	while (directory !== dirname(directory)) {
		const file = Bun.file(join(directory, "package.json"));
		if (await file.exists()) {
			const metadata = await file.json();
			if (
				typeof metadata.name === "string" &&
				typeof metadata.version === "string"
			) {
				const name = `${metadata.name.replaceAll("/", "_")}@${metadata.version}`;
				const notices = (await readdir(directory)).filter((entry) =>
					/^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/i.test(entry),
				);
				if (!notices.length)
					throw new Error(`Missing bundled dependency notices: ${name}`);
				await mkdir(join(destination, name), { recursive: true });
				for (const notice of notices) {
					if (!(await lstat(join(directory, notice))).isFile())
						throw new Error(`Unexpected notice file: ${name}`);
					await copyFile(
						join(directory, notice),
						join(destination, name, notice),
					);
				}
				return name;
			}
		}
		directory = dirname(directory);
	}
	throw new Error("Cannot identify bundled dependency");
}

export async function buildClients(
	output = resolve(root, "out/clients"),
): Promise<string> {
	if (process.platform !== "linux" || process.arch !== "x64")
		throw new Error("Client packaging currently requires Linux x64");
	const runtime = await officialRuntime(join(output, "toolchain"));
	const sourceDirty =
		(await command(
			["git", "status", "--porcelain", "--untracked-files=no"],
			true,
		)) !== "";
	const sourceSha = await command(["git", "rev-parse", "HEAD"], true);
	if (!/^[a-f0-9]{40}$/.test(sourceSha))
		throw new Error("Invalid source identity");
	const sourceEpoch = await command(
		["git", "show", "-s", "--format=%ct", "HEAD"],
		true,
	);
	const build = {
		version: release.version,
		sourceSha,
		sourceDirty,
		runtimeArchiveSha256,
		bunVersion: await command([runtime, "--version"], true),
		bunRevision: await command(
			[runtime, "-e", "console.log(Bun.revision)"],
			true,
		),
		target,
	};
	const directory = join(output, `ditero-${release.version}-clients-linux-x64`);
	if (await Bun.file(join(directory, "BUILDINFO.json")).exists())
		throw new Error("Use a fresh client output directory");
	await mkdir(directory);
	await mkdir(join(directory, "bin"));
	await mkdir(join(directory, "relink"), { recursive: true });
	await mkdir(join(directory, "notices"), { recursive: true });
	const cpus = buildCpus(await readFile("/proc/self/status", "utf8")).join(",");
	const packages = new Set<string>();
	for (const [name, entry] of Object.entries(clients)) {
		const metafile = join(output, `${name}.meta.json`);
		await command([
			"taskset",
			"-c",
			cpus,
			runtime,
			"build",
			"--target=bun",
			"--minify",
			"--reject-unresolved",
			`--define=DITERO_CLIENT_BUILD=${JSON.stringify(build)}`,
			`--outfile=${join(directory, "relink", `${name}.js`)}`,
			entry,
		]);
		await command([
			"taskset",
			"-c",
			cpus,
			runtime,
			"build",
			"--compile",
			`--compile-executable-path=${runtime}`,
			`--target=${target}`,
			"--minify",
			"--reject-unresolved",
			"--no-compile-autoload-dotenv",
			"--no-compile-autoload-bunfig",
			"--no-compile-autoload-tsconfig",
			"--no-compile-autoload-package-json",
			`--define=DITERO_CLIENT_BUILD=${JSON.stringify(build)}`,
			`--metafile=${metafile}`,
			`--outfile=${join(directory, "bin", name)}`,
			entry,
		]);
		const metadata = await Bun.file(metafile).json();
		for (const input of Object.keys(metadata.inputs)) {
			const notice = await packageNotices(input, join(directory, "notices"));
			if (notice) packages.add(notice);
		}
	}
	const runtimeNotice = await fetch(
		`https://raw.githubusercontent.com/oven-sh/bun/${build.bunRevision}/LICENSE.md`,
	);
	if (!runtimeNotice.ok)
		throw new Error("Could not retrieve the exact Bun runtime notice");
	await writeFile(
		join(directory, "notices", "Bun-LICENSE.md"),
		await runtimeNotice.text(),
	);
	await copyFile(join(root, "LICENSE"), join(directory, "LICENSE"));
	await writeFile(
		join(directory, "REBUILD.md"),
		`# Local candidate only\n\nRuntime license/copyright notice qualification is incomplete (https://github.com/iuliandita/ditero/issues/575). This archive is not a published release asset and must not be uploaded as a binary distribution. notices/Bun-LICENSE.md is an upstream inventory, not complete embedded runtime license texts.\n\n## Relinking the clients\n\nThe relink/*.js files contain the bundled application inputs. They do not require the source checkout or npm dependencies. Bun runtime notices and upstream library/source links are in notices/Bun-LICENSE.md.\n\nTo replace Bun's statically linked JavaScriptCore, follow those upstream build instructions at Bun revision ${build.bunRevision}. Then use Bun ${build.bunVersion} with the modified runtime:\n\n\`\`\`sh\nfor client in ditero ditero-mcp ditero-tui; do\n  bun build --compile --target=bun-linux-x64 --compile-executable-path=/path/to/modified/bun --no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-tsconfig --no-compile-autoload-package-json --outfile="bin/$client" "relink/$client.js"\ndone\n\`\`\`\n\nThese Linux x64 glibc clients embed Bun. Caller-controlled Bun runtime environment flags are trusted runtime configuration, not a sandbox. Automatic .env, bunfig.toml, package.json, and tsconfig.json loading is disabled.\n`,
	);
	await writeFile(
		join(directory, "BUILDINFO.json"),
		`${JSON.stringify({ ...build, runtimeNoticesComplete: false, apiVersion: 1, clients: Object.keys(clients), dependencies: [...packages].sort() }, null, 2)}\n`,
	);
	const archive = join(
		output,
		`ditero-${release.version}-clients-linux-x64.tar.gz`,
	);
	await command([
		"tar",
		"--sort=name",
		`--mtime=@${sourceEpoch}`,
		"--owner=0",
		"--group=0",
		"--numeric-owner",
		"--mode=u+rwX,go+rX,go-w",
		"-czf",
		archive,
		"-C",
		output,
		directory.slice(output.length + 1),
	]);
	return archive;
}

if (import.meta.main) {
	if (process.argv.length > 3)
		throw new Error("Usage: bun scripts/build-clients.ts [OUTPUT_DIRECTORY]");
	console.log(
		await buildClients(process.argv[2] ? resolve(process.argv[2]) : undefined),
	);
}
