import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	bannerFor,
	inlinedNotice,
	inlinedPackages,
	packageNotice,
	renderNotices,
} from "./build-clients.ts";

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

describe("packages inlined into a dependency", () => {
	const region = (path: string) =>
		`//#region ${path}\nexport {};\n//#endregion\n`;

	test("are read from the region comments of the shipped file", () => {
		const text = [
			region(
				"../../node_modules/.pnpm/ajv@8.18.0/node_modules/ajv/dist/core.js",
			),
			region("../../node_modules/.pnpm/ajv@8.18.0/node_modules/ajv/dist/x.js"),
			region(
				"../../node_modules/.pnpm/ajv-formats@3.0.1_ajv@8.18.0/node_modules/ajv-formats/dist/index.js",
			),
			region(
				"../../node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg/index.js",
			),
			region("../core/src/own.ts"),
		].join("");
		expect(inlinedPackages(text)).toEqual([
			"@scope/pkg@1.0.0",
			"ajv-formats@3.0.1",
			"ajv@8.18.0",
		]);
		expect(inlinedPackages("export {};")).toEqual([]);
	});

	test("fail the build when a region names a package without a version", () => {
		expect(() =>
			inlinedPackages(region("../../node_modules/loose/index.js")),
		).toThrow("Cannot identify a package inlined into a dependency");
	});

	test("take the license text from the installed copy, the same package, or the vendor", async () => {
		const modules = await mkdtemp(join(tmpdir(), "ditero-inlined-"));
		directories.push(modules);
		const install = async (name: string, version: string, text: string) => {
			await mkdir(join(modules, name), { recursive: true });
			await writeFile(
				join(modules, name, "package.json"),
				JSON.stringify({ name, version, license: "MIT" }),
			);
			await writeFile(join(modules, name, "LICENSE"), text);
		};
		await install("exact", "1.0.0", "exact license text");
		await install("newer", "2.0.0", "newer license text");
		const vendor = {
			name: "vendor",
			version: "9.9.9",
			license: "Apache-2.0",
			files: [{ name: "LICENSE", text: "vendor license text" }],
		};
		const exact = await inlinedNotice("exact@1.0.0", vendor, modules);
		expect(exact.source).toBeUndefined();
		expect(exact.files[0].text).toBe("exact license text");
		const mismatch = await inlinedNotice("newer@1.5.0", vendor, modules);
		expect(mismatch).toMatchObject({ name: "newer", version: "1.5.0" });
		expect(mismatch.files[0].text).toBe("newer license text");
		expect(mismatch.source).toContain("installed newer@2.0.0");
		const missing = await inlinedNotice("gone@3.0.0", vendor, modules);
		expect(missing).toMatchObject({ name: "gone", version: "3.0.0" });
		expect(missing.files[0].text).toBe("vendor license text");
		expect(renderNotices([missing])).toContain(
			"gone@3.0.0 (Apache-2.0; license text of vendor@9.9.9, which vendors this code; gone@3.0.0 is not installed)",
		);
	});

	test("are marked in the real MCP bundle", () => {
		const script = `
import { packageMarkers, markerFor } from ${JSON.stringify(join(import.meta.dirname, "build-clients.ts"))};
const inlined = new Map();
const result = await Bun.build({ entrypoints: [${JSON.stringify(join(import.meta.dirname, "../src/mcp/index.ts"))}], target: "bun", minify: true, plugins: [packageMarkers(inlined)] });
const text = await result.outputs[0].text();
console.log(JSON.stringify([...inlined.keys()].filter((id) => text.includes(markerFor(id)))));`;
		const run = spawnSync("bun", ["-e", script], { encoding: "utf8" });
		expect(run.status, run.stderr).toBe(0);
		const marked: string[] = JSON.parse(run.stdout);
		for (const name of [
			"ajv",
			"ajv-formats",
			"fast-deep-equal",
			"fast-uri",
			"json-schema-traverse",
		])
			expect(
				marked.some((id) => id.startsWith(`${name}@`)),
				name,
			).toBe(true);
	}, 60_000);
});

test("the startup banner stops an older Bun before any client code runs", () => {
	const run = (minimum: string, reported?: string) =>
		spawnSync(
			"bun",
			[
				"-e",
				`${reported === undefined ? "" : `Object.defineProperty(process.versions,"bun",{value:${JSON.stringify(reported)}});`}${bannerFor(minimum).split("\n").slice(1).join("\n")}console.log("ran")`,
			],
			{ encoding: "utf8" },
		);
	expect(run("1.0.0")).toMatchObject({ status: 0, stdout: "ran\n" });
	for (const reported of ["1.4.4", "1.4.4-canary.1+963452075", "2.0.0-rc.1"])
		expect(run("1.4.4", reported), reported).toMatchObject({ status: 0 });
	for (const reported of ["1.4.3", "1.3.99-canary.7", "garbage", ""])
		expect(run("1.4.4", reported).status, reported).toBe(2);
	const refused = run("99.0.0");
	expect(refused.status).toBe(2);
	expect(refused.stdout).toBe("");
	expect(refused.stderr).toContain("Bun 99.0.0 or newer is required");
});
