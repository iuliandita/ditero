import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import release from "../../release.json";

const ownedContainers = new Map<string, { owner: string; extracted: string }>();

export function cleanupContainers(
	extracted: string,
	originalFailure?: unknown,
): void {
	try {
		for (const [name, fixture] of ownedContainers) {
			if (fixture.extracted !== extracted) continue;
			const inspect = spawnSync("docker", ["inspect", name], {
				encoding: "utf8",
			});
			if (inspect.status !== 0) {
				if (
					inspect.status === 1 &&
					/No such (object|container)/i.test(inspect.stderr)
				) {
					ownedContainers.delete(name);
					continue;
				}
				throw new Error(
					"Could not inspect the owned client fixture during cleanup",
				);
			}
			const containers = JSON.parse(inspect.stdout);
			if (
				containers.length !== 1 ||
				containers[0].Config.Labels?.["ditero.client-fixture"] !==
					fixture.owner ||
				!/^[a-f0-9]{64}$/.test(containers[0].Id)
			)
				throw new Error("Client fixture ownership changed during cleanup");
			execFileSync("docker", ["rm", "--force", containers[0].Id], {
				stdio: "pipe",
			});
			const retired = spawnSync("docker", ["inspect", containers[0].Id], {
				encoding: "utf8",
			});
			if (
				retired.status !== 1 ||
				!/No such (object|container)/i.test(retired.stderr)
			)
				throw new Error("Owned client fixture did not retire");
			ownedContainers.delete(name);
		}
	} catch (error) {
		if (originalFailure !== undefined) {
			process.stderr.write("Owned client fixture cleanup also failed.\n");
			throw originalFailure;
		}
		throw error;
	}
}

export const clientImage =
	"ubuntu@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3";
export async function extractClients() {
	const directory = await mkdtemp(join(tmpdir(), "ditero-clients-"));
	try {
		const archive =
			process.env.STANDALONE_CLIENT_ARCHIVE ??
			(() => {
				const result = execFileSync(
					"bun",
					["scripts/build-clients.ts", join(directory, "build")],
					{ encoding: "utf8", maxBuffer: 1024 * 1024 },
				);
				return result.trim().split("\n").at(-1) ?? "";
			})();
		const prefix = `ditero-${release.version}-clients-linux-x64`;
		const entries = execFileSync("tar", ["-tzf", resolve(archive)], {
			encoding: "utf8",
		})
			.trim()
			.split("\n");
		const top = new Set([
			"bin",
			"relink",
			"notices",
			"LICENSE",
			"BUILDINFO.json",
			"REBUILD.md",
		]);
		for (const entry of entries) {
			const segments = entry.split("/");
			if (
				segments[0] !== prefix ||
				segments.includes("..") ||
				segments.some((part) => part.startsWith(".")) ||
				(segments[1] && !top.has(segments[1]))
			)
				throw new Error("Unexpected client archive entry");
		}
		execFileSync("tar", ["-xzf", resolve(archive), "-C", directory]);
		const extracted = join(directory, prefix);
		const info = JSON.parse(
			await readFile(join(extracted, "BUILDINFO.json"), "utf8"),
		);
		if (
			info.version !== release.version ||
			info.target !== "bun-linux-x64" ||
			info.apiVersion !== 1 ||
			!/^[a-f0-9]{40}$/.test(info.sourceSha) ||
			!/^[a-f0-9]{40}$/.test(info.bunRevision)
		)
			throw new Error("Invalid client build identity");
		for (const name of ["ditero", "ditero-mcp", "ditero-tui"]) {
			if (
				!entries.includes(`${prefix}/bin/${name}`) ||
				!entries.includes(`${prefix}/relink/${name}.js`)
			)
				throw new Error("Missing client or relink input");
		}
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
			'throw new Error("HOSTILE_PRELOAD");\n',
		);
		return {
			extracted,
			info,
			entries,
			archive,
			close: async () => {
				cleanupContainers(extracted);
				await rm(directory, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

export function containerCommand(
	extracted: string,
	binary: string,
	terminal = false,
): string[] {
	const owner = randomUUID();
	const name = `ditero-client-fixture-${owner}`;
	ownedContainers.set(name, { owner, extracted });
	const base = [
		"run",
		"--name",
		name,
		"--label",
		`ditero.client-fixture=${owner}`,
		"--rm",
		"--network",
		"host",
		"--read-only",
		"--tmpfs",
		"/tmp:rw,noexec,nosuid",
		"--mount",
		`type=bind,src=${extracted},dst=/clients,readonly`,
		"--workdir",
		"/clients",
		"--env",
		"DITERO_URL",
		"--env",
		"DITERO_TOKEN",
		"--env",
		"TERM",
	];
	if (terminal)
		return [
			...base,
			"-it",
			clientImage,
			"bash",
			"-c",
			'before=$(stty -g); /clients/bin/ditero-tui --allow-loopback-http; status=$?; after=$(stty -g); if [ "$before" != "$after" ]; then echo INNER_TERMINAL_BROKEN; exit 99; fi; echo INNER_TERMINAL_RESTORED; exit "$status"',
		];
	return [...base, "-i", clientImage, `/clients/bin/${binary}`];
}
