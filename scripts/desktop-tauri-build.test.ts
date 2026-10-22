import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const script = resolve("scripts/desktop-tauri-build.sh");
const target = "x86_64-apple-darwin";
const roots: string[] = [];

const stub = `#!/usr/bin/env bash
n=$(( $(cat count 2>/dev/null || echo 0) + 1 ))
echo "$n" > count
mode=$(echo "$SEQUENCE" | cut -d, -f"$n")
case "$mode" in
  ok) exit 0 ;;
  busy:*) echo 'hdiutil: couldn'"'"'t eject "disk2" - Resource busy' >&2; exit "\${mode#busy:}" ;;
  fail:*) echo 'error: unrelated packaging failure' >&2; exit "\${mode#fail:}" ;;
esac
exit 99
`;

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ditero-desktop-build-"));
	roots.push(root);
	const bundle = join(root, "src-tauri/target", target, "debug/bundle");
	mkdirSync(join(bundle, "macos"), { recursive: true });
	mkdirSync(join(bundle, "dmg"), { recursive: true });
	mkdirSync(join(root, "volumes/dmg.AbC123"), { recursive: true });
	mkdirSync(join(root, "volumes/Macintosh"), { recursive: true });
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "build.sh"), stub);
	chmodSync(join(root, "build.sh"), 0o755);
	writeFileSync(
		join(root, "bin/hdiutil"),
		`#!/usr/bin/env bash\necho "$*" >> "${join(root, "hdiutil.log")}"\n`,
	);
	chmodSync(join(root, "bin/hdiutil"), 0o755);
	writeFileSync(join(bundle, "macos/rw.123.Ditero.dmg"), "stale");
	writeFileSync(join(bundle, "macos/Ditero.app"), "keep");
	writeFileSync(join(bundle, "dmg/rw.9.Ditero.dmg"), "keep");
	return { root, bundle };
}

function run(root: string, os: string, sequence: string) {
	const result = spawnSync("bash", [script, "--", join(root, "build.sh")], {
		cwd: root,
		encoding: "utf8",
		env: {
			PATH: `${join(root, "bin")}:${process.env.PATH}`,
			RUNNER_OS: os,
			RUNNER_TEMP: root,
			DESKTOP_TARGET: target,
			DESKTOP_VOLUMES_DIR: join(root, "volumes"),
			SEQUENCE: sequence,
		},
	});
	const attempts = Number(readFileSync(join(root, "count"), "utf8"));
	return { ...result, attempts };
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("desktop build retry", () => {
	test.each([
		{ name: "success", os: "macOS", seq: "ok", status: 0, attempts: 1 },
		{
			name: "eject busy once then success",
			os: "macOS",
			seq: "busy:11,ok",
			status: 0,
			attempts: 2,
		},
		{
			name: "eject busy until attempts are exhausted",
			os: "macOS",
			seq: "busy:11,busy:12,busy:13,ok",
			status: 13,
			attempts: 3,
		},
		{
			name: "unrelated failure on macOS",
			os: "macOS",
			seq: "fail:9,ok",
			status: 9,
			attempts: 1,
		},
		{
			name: "eject busy signature on Linux",
			os: "Linux",
			seq: "busy:11,ok",
			status: 11,
			attempts: 1,
		},
	])("$name", ({ os, seq, status, attempts }) => {
		const { root } = fixture();
		const result = run(root, os, seq);
		expect(result.error).toBeUndefined();
		expect({ status: result.status, attempts: result.attempts }).toEqual({
			status,
			attempts,
		});
	});

	test("detaches dmg volumes and removes only stale rw images before retrying", () => {
		const { root, bundle } = fixture();
		const result = run(root, "macOS", "busy:11,ok");
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(join(root, "hdiutil.log"), "utf8")).toBe(
			`detach -force ${join(root, "volumes/dmg.AbC123")}\n`,
		);
		expect(existsSync(join(bundle, "macos/rw.123.Ditero.dmg"))).toBe(false);
		expect(existsSync(join(bundle, "macos/Ditero.app"))).toBe(true);
		expect(existsSync(join(bundle, "dmg/rw.9.Ditero.dmg"))).toBe(true);
	});
});
