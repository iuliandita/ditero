import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((path) => rm(path, { recursive: true })),
	);
});

async function runLoader(script: string, env: Record<string, string>) {
	return new Promise<{ exitCode: number; stdout: string; stderr: string }>(
		(resolve) => {
			const child = spawn("sh", ["-c", script], {
				cwd: process.cwd(),
				env: { PATH: process.env.PATH ?? "", ...env },
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			child.on("close", (exitCode) => {
				resolve({ exitCode: exitCode ?? 1, stdout, stderr });
			});
		},
	);
}

describe("container secret-file loader", () => {
	test("loads a required secret without retaining a trailing newline", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ditero-secret-"));
		directories.push(directory);
		const path = join(directory, "auth");
		await writeFile(path, "file-secret\n", { mode: 0o600 });

		const result = await runLoader(
			'. deploy/docker/secret-file.sh; load_secret BETTER_AUTH_SECRET required; printf "%s" "$BETTER_AUTH_SECRET"',
			{ BETTER_AUTH_SECRET_FILE: path },
		);
		expect(result).toMatchObject({ exitCode: 0, stdout: "file-secret" });
	});

	test("rejects simultaneous inline and file values", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ditero-secret-"));
		directories.push(directory);
		const path = join(directory, "auth");
		await writeFile(path, "file-secret", { mode: 0o600 });

		const result = await runLoader(
			". deploy/docker/secret-file.sh; load_secret BETTER_AUTH_SECRET required",
			{
				BETTER_AUTH_SECRET: "inline-secret",
				BETTER_AUTH_SECRET_FILE: path,
			},
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/both/i);
	});

	test("rejects missing and empty secret files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ditero-secret-"));
		directories.push(directory);
		const empty = join(directory, "empty");
		await writeFile(empty, "", { mode: 0o600 });

		for (const path of [join(directory, "missing"), empty]) {
			const result = await runLoader(
				". deploy/docker/secret-file.sh; load_secret DATABASE_URL required",
				{ DATABASE_URL_FILE: path },
			);
			expect(result.exitCode).not.toBe(0);
		}
	});

	test("accepts the read-only permissions used by container secrets", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ditero-secret-"));
		directories.push(directory);
		const path = join(directory, "secret");
		await writeFile(path, "value", { mode: 0o444 });
		await chmod(path, 0o444);
		const result = await runLoader(
			'. deploy/docker/secret-file.sh; load_secret VALUE required; printf "%s" "$VALUE"',
			{ VALUE_FILE: path },
		);
		expect(result).toMatchObject({ exitCode: 0, stdout: "value" });
	});

	test("rejects an absent required secret", async () => {
		const result = await runLoader(
			". deploy/docker/secret-file.sh; load_secret BETTER_AUTH_SECRET required",
			{},
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/required/i);
	});
});

import { spawn } from "node:child_process";
