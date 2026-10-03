import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const roots: string[] = [];
const version = "0.0.1-alpha.1";
const packages = [
	{
		platform: "linux",
		label: "linux-x64-unsigned",
		files: [
			[
				"apps/desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/deb/original.deb",
				"deb",
			],
			[
				"apps/desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage/original.AppImage",
				"AppImage",
			],
		],
	},
	{
		platform: "windows",
		label: "windows-x64-unsigned",
		files: [
			[
				"apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/original.exe",
				"exe",
			],
		],
	},
	{
		platform: "macos",
		label: "macos-arm64-adhoc",
		files: [
			[
				"apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/original.dmg",
				"dmg",
			],
		],
	},
	{
		platform: "android",
		label: "android-independent-universal-signed",
		files: [
			[
				"apps/android/android/app/build/outputs/apk/independent/release/original.apk",
				"apk",
			],
			[
				"apps/android/android/app/build/outputs/bundle/independentRelease/original.aab",
				"aab",
			],
		],
	},
] as const;

function fixture(files: readonly (readonly [string, string])[]): string {
	const root = mkdtempSync(join(tmpdir(), "ditero-native-artifacts-"));
	roots.push(root);
	for (const [path, contents] of files) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), contents);
	}
	return root;
}

function collect(root: string, platform: string, releaseVersion = version) {
	return spawnSync(
		"python3",
		[
			"scripts/native-artifacts.py",
			"--root",
			root,
			"--output",
			join(root, "out"),
			"--platform",
			platform,
			"--version",
			releaseVersion,
		],
		{ encoding: "utf8" },
	);
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("native release artifact collection", () => {
	test.each(packages)("collects $platform packages with preserved contents", ({
		platform,
		label,
		files,
	}) => {
		const root = fixture(files);
		const result = collect(root, platform);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		const names = files.map(
			([, extension]) => `ditero-${version}-${label}.${extension}`,
		);
		expect(readdirSync(join(root, "out")).sort()).toEqual(names.sort());
		for (const [, extension] of files) {
			expect(
				readFileSync(
					join(root, "out", `ditero-${version}-${label}.${extension}`),
					"utf8",
				),
			).toBe(extension);
		}
	});

	test("refuses a missing required package before copying other packages", () => {
		const root = fixture([packages[0].files[0]]);
		const result = collect(root, "linux");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"expected exactly one linux AppImage package, found 0",
		);
		expect(readdirSync(root)).toEqual(["apps"]);
	});

	test("refuses duplicate packages", () => {
		const root = fixture([
			...packages[1].files,
			[packages[1].files[0][0].replace("original", "duplicate"), "exe"],
		]);
		const result = collect(root, "windows");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"expected exactly one windows exe package, found 2",
		);
	});

	test("refuses empty packages", () => {
		const root = fixture([[packages[2].files[0][0], ""]]);
		const result = collect(root, "macos");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("nonempty regular file");
	});

	test("refuses unsafe version names and stale output files", () => {
		const root = fixture(packages[1].files);
		expect(collect(root, "windows", "../../escape").status).toBe(1);
		mkdirSync(join(root, "out"));
		writeFileSync(join(root, "out", "stale.exe"), "stale");
		const result = collect(root, "windows");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("artifact output directory must be empty");
		expect(readFileSync(join(root, "out", "stale.exe"), "utf8")).toBe("stale");
	});
});
