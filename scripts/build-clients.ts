import { createHash } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import release from "../release.json";
import { MINIMUM_BUN } from "../src/clients/build-info.ts";

const root = resolve(import.meta.dirname, "..");

export const clients = {
	"ditero-cli.js": { name: "ditero", entry: "src/cli/index.ts" },
	"ditero-mcp.js": { name: "ditero-mcp", entry: "src/mcp/index.ts" },
	"ditero-tui.js": { name: "ditero-tui", entry: "src/tui/index.ts" },
} as const;

// Direct execution must not trust the caller's working directory: Bun would
// otherwise load its .env and run bunfig.toml preloads before any client code.
export const SHEBANG = "#!/usr/bin/env -S bun --no-env-file --config=/dev/null";

export function bannerFor(minimum: string): string {
	const wanted = JSON.stringify(minimum.split(".").map(Number));
	return `${SHEBANG}\n{const m=${wanted},v=(process.versions.bun||"").split(".").slice(0,3).map(Number);if(!(v.length===3&&v.every(Number.isInteger)&&(v[0]-m[0]||v[1]-m[1]||v[2]-m[2])>=0)){console.error("ditero: Bun ${minimum} or newer is required (found "+(process.versions.bun||"no Bun runtime")+"). Install it from https://bun.sh");process.exit(2)}}\n`;
}

async function command(argv: string[]): Promise<string> {
	const child = Bun.spawn(argv, {
		cwd: root,
		stdout: "pipe",
		stderr: "inherit",
	});
	const result = await new Response(child.stdout).text();
	if ((await child.exited) !== 0)
		throw new Error(`Client packaging command failed: ${argv[0]}`);
	return result.trim();
}

export type PackageNotice = {
	name: string;
	version: string;
	license: string;
	files: { name: string; text: string }[];
};

const noticeFile = /^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/i;

export async function packageNotice(
	input: string,
): Promise<PackageNotice | null> {
	if (!input.includes("node_modules/")) return null;
	let directory = dirname(await realpath(resolve(root, input)));
	while (directory !== dirname(directory)) {
		const manifest = await readFile(
			join(directory, "package.json"),
			"utf8",
		).catch(() => null);
		if (manifest !== null) {
			const metadata = JSON.parse(manifest);
			if (
				typeof metadata.name === "string" &&
				typeof metadata.version === "string"
			) {
				const id = `${metadata.name}@${metadata.version}`;
				const files: PackageNotice["files"] = [];
				for (const entry of (await readdir(directory)).sort()) {
					if (!noticeFile.test(entry)) continue;
					if (!(await lstat(join(directory, entry))).isFile())
						throw new Error(`Unexpected notice file: ${id}`);
					const text = await readFile(join(directory, entry), "utf8");
					if (text.trim()) files.push({ name: entry, text });
				}
				if (!files.length)
					throw new Error(`Missing bundled dependency license text: ${id}`);
				const license =
					typeof metadata.license === "string"
						? metadata.license
						: "see license text";
				return {
					name: metadata.name,
					version: metadata.version,
					license,
					files,
				};
			}
		}
		directory = dirname(directory);
	}
	throw new Error(`Cannot identify bundled dependency: ${input}`);
}

export function renderNotices(packages: readonly PackageNotice[]): string {
	if (!packages.length)
		throw new Error("The bundles must list their third-party dependencies");
	const sorted = [...packages].sort((a, b) =>
		`${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
	);
	const sections = sorted.map(
		(item) =>
			`${"=".repeat(72)}\n${item.name}@${item.version} (${item.license})\n${"=".repeat(72)}\n\n${item.files.map((file) => `${file.name}\n\n${file.text.trim()}`).join("\n\n")}\n`,
	);
	return `THIRD-PARTY NOTICES\n\nThe Ditero terminal client bundles include the following npm packages.\nDitero itself is distributed under the MIT license in LICENSE.\n\n${sections.join("\n")}`;
}

export async function buildClients(
	output = resolve(root, "out/clients"),
): Promise<string> {
	const sourceDirty =
		(await command([
			"git",
			"status",
			"--porcelain",
			"--untracked-files=no",
		])) !== "";
	const sourceSha = await command(["git", "rev-parse", "HEAD"]);
	if (!/^[a-f0-9]{40}$/.test(sourceSha))
		throw new Error("Invalid source identity");
	const sourceEpoch = await command([
		"git",
		"show",
		"-s",
		"--format=%ct",
		"HEAD",
	]);
	const build = {
		version: release.version,
		sourceSha,
		sourceDirty,
		target: "bun",
	};
	const prefix = `ditero-${release.version}-clients`;
	const directory = join(output, prefix);
	if (await Bun.file(join(directory, "BUILDINFO.json")).exists())
		throw new Error("Use a fresh client output directory");
	await mkdir(directory, { recursive: true });

	const packages = new Map<string, PackageNotice>();
	const checksums: Record<string, string> = {};
	for (const [file, { entry }] of Object.entries(clients)) {
		const result = await Bun.build({
			entrypoints: [resolve(root, entry)],
			target: "bun",
			minify: true,
			sourcemap: "none",
			banner: bannerFor(MINIMUM_BUN),
			define: { DITERO_CLIENT_BUILD: JSON.stringify(build) },
			metafile: true,
		});
		if (!result.success || result.outputs.length !== 1)
			throw new Error(`Client bundle failed: ${file}`);
		for (const input of Object.keys(result.metafile?.inputs ?? {})) {
			const notice = await packageNotice(input);
			if (notice) packages.set(`${notice.name}@${notice.version}`, notice);
		}
		const bytes = new Uint8Array(await result.outputs[0].arrayBuffer());
		await writeFile(join(directory, file), bytes);
		await chmod(join(directory, file), 0o755);
		checksums[file] = createHash("sha256").update(bytes).digest("hex");
	}

	await writeFile(
		join(directory, "THIRD_PARTY_NOTICES.txt"),
		renderNotices([...packages.values()]),
	);
	await writeFile(
		join(directory, "LICENSE"),
		await readFile(join(root, "LICENSE")),
	);
	await writeFile(
		join(directory, "BUILDINFO.json"),
		`${JSON.stringify(
			{
				...build,
				apiVersion: 1,
				minimumBun: MINIMUM_BUN,
				clients: Object.keys(clients),
				dependencies: [...packages.keys()].sort(),
			},
			null,
			2,
		)}\n`,
	);
	const names = [
		...Object.keys(clients),
		"THIRD_PARTY_NOTICES.txt",
		"LICENSE",
		"BUILDINFO.json",
	];
	const sums: string[] = [];
	for (const name of names) {
		const digest =
			checksums[name] ??
			createHash("sha256")
				.update(new Uint8Array(await readFile(join(directory, name))))
				.digest("hex");
		sums.push(`${digest}  ${name}\n`);
	}
	await writeFile(join(directory, "SHA256SUMS"), sums.join(""));

	for (const [file, { name }] of Object.entries(clients)) {
		const version = JSON.parse(
			await command([process.execPath, join(directory, file), "--version"]),
		);
		if (
			version.name !== name ||
			version.version !== release.version ||
			version.commit !== sourceSha
		)
			throw new Error(`Built bundle reports the wrong identity: ${file}`);
	}

	const archive = join(output, `${prefix}.tar.gz`);
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
		prefix,
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
