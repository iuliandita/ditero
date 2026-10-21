import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import release from "../../release.json";

export const clientBun = process.env.CLIENT_BUN ?? "bun";
export const bundleNames = {
	ditero: "ditero-cli.js",
	"ditero-mcp": "ditero-mcp.js",
	"ditero-tui": "ditero-tui.js",
} as const;

export async function extractBundles() {
	const directory = await mkdtemp(join(tmpdir(), "ditero-clients-"));
	try {
		const archive =
			process.env.CLIENT_ARCHIVE ??
			execFileSync(
				"bun",
				["scripts/build-clients.ts", join(directory, "build")],
				{
					encoding: "utf8",
				},
			)
				.trim()
				.split("\n")
				.at(-1) ??
			"";
		const prefix = `ditero-${release.version}-clients`;
		execFileSync("tar", ["-xzf", resolve(archive), "-C", directory]);
		const extracted = join(directory, prefix);
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
		await writeFile(
			join(extracted, ".env"),
			`DITERO_URL=https://poison.example.test\nDITERO_TOKEN=ditero_pat_${"A".repeat(43)}\n`,
		);
		return {
			extracted,
			info,
			close: () => rm(directory, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

export function bundleCommand(
	extracted: string,
	name: keyof typeof bundleNames,
) {
	return [clientBun, join(extracted, bundleNames[name])];
}
