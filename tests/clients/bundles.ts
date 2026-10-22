import { execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import release from "../../release.json";

export const clientBun = process.env.CLIENT_BUN ?? "bun";
export const bundleNames = {
	ditero: "ditero-cli.js",
	"ditero-mcp": "ditero-mcp.js",
	"ditero-tui": "ditero-tui.js",
} as const;

// Bundles are executed through their shebang, as a user would, from a working
// directory holding hostile Bun configuration. PATH selects the Bun under test.
export async function extractBundles() {
	const directory = await mkdtemp(join(tmpdir(), "ditero-clients-"));
	try {
		const archive =
			process.env.CLIENT_ARCHIVE ??
			execFileSync(
				"bun",
				["scripts/build-clients.ts", join(directory, "build")],
				{ encoding: "utf8" },
			)
				.trim()
				.split("\n")
				.at(-1) ??
			"";
		execFileSync("tar", ["-xzf", resolve(archive), "-C", directory]);
		const extracted = join(directory, `ditero-${release.version}-clients`);
		const info = JSON.parse(
			await readFile(join(extracted, "BUILDINFO.json"), "utf8"),
		);
		if (
			info.version !== release.version ||
			info.target !== "bun" ||
			info.apiVersion !== 1 ||
			!/^[a-f0-9]{40}$/.test(info.sourceSha)
		)
			throw new Error("Invalid client build identity");
		const real = isAbsolute(clientBun)
			? clientBun
			: execFileSync("which", [clientBun], { encoding: "utf8" }).trim();
		const bin = join(directory, "bin");
		await mkdir(bin);
		await symlink(real, join(bin, "bun"));
		await writeFile(
			join(extracted, ".env"),
			`DITERO_URL=https://poison.example.test\nDITERO_TOKEN=ditero_pat_${"A".repeat(43)}\n`,
		);
		await writeFile(
			join(extracted, "bunfig.toml"),
			'preload = ["./hostile.ts"]\n',
		);
		await writeFile(
			join(extracted, "hostile.ts"),
			'process.stderr.write("HOSTILE_PRELOAD\\n");\n',
		);
		return {
			extracted,
			info,
			path: `${bin}${delimiter}${process.env.PATH ?? ""}`,
			close: () => rm(directory, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

export function bundlePath(extracted: string, name: keyof typeof bundleNames) {
	return join(extracted, bundleNames[name]);
}
