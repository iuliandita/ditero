import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { bannerFor, packageNotice, renderNotices } from "./build-clients.ts";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

async function dependency(files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), "ditero-notice-"));
	directories.push(root);
	const pkg = join(root, "node_modules/fixture");
	await mkdir(pkg, { recursive: true });
	await writeFile(
		join(pkg, "package.json"),
		JSON.stringify({ name: "fixture", version: "1.2.3", license: "MIT" }),
	);
	await writeFile(join(pkg, "index.js"), "export {};");
	for (const [name, text] of Object.entries(files))
		await writeFile(join(pkg, name), text);
	return join(pkg, "index.js");
}

describe("third-party notices", () => {
	test("collect every license file of a bundled package", async () => {
		const input = await dependency({
			LICENSE: "MIT License\n\nPermission is hereby granted",
			"NOTICE.md": "Notice text",
		});
		const notice = await packageNotice(input);
		expect(notice).toMatchObject({ name: "fixture", version: "1.2.3" });
		expect(notice?.files.map((file) => file.name)).toEqual([
			"LICENSE",
			"NOTICE.md",
		]);
		expect(renderNotices([notice as NonNullable<typeof notice>])).toContain(
			"fixture@1.2.3 (MIT)",
		);
	});

	test.each([
		["no license file", {}],
		["an empty license file", { LICENSE: " \n" }],
	])("fail the build for a bundled package with %s", async (_name, files) => {
		await expect(packageNotice(await dependency(files))).rejects.toThrow(
			"Missing bundled dependency license text: fixture@1.2.3",
		);
	});

	test("ignore sources outside node_modules and refuse an empty inventory", async () => {
		expect(await packageNotice("src/cli/index.ts")).toBeNull();
		expect(() => renderNotices([])).toThrow("third-party dependencies");
	});
});

test("the startup banner stops an older Bun before any client code runs", () => {
	const run = (minimum: string) =>
		spawnSync(
			"bun",
			[
				"-e",
				`${bannerFor(minimum).split("\n").slice(1).join("\n")}console.log("ran")`,
			],
			{ encoding: "utf8" },
		);
	expect(run("1.0.0")).toMatchObject({ status: 0, stdout: "ran\n" });
	const refused = run("99.0.0");
	expect(refused.status).toBe(2);
	expect(refused.stdout).toBe("");
	expect(refused.stderr).toContain("Bun 99.0.0 or newer is required");
});
