// Build-only refusal gates; native apk output contracts must be qualified on both arches.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const arch = { amd64: "x86_64", arm64: "aarch64" }[process.argv[2]];
if (!arch || readFileSync("/etc/alpine-release", "utf8").trim() !== "3.24.2")
	throw Error("qualified Alpine3.24.2 base required");
const lock = JSON.parse(
	readFileSync(new URL("packages.lock.json", import.meta.url)),
);
const installed = execFileSync("apk", ["info", "-v"], { encoding: "utf8" })
	.trim()
	.split("\n");
const selected = lock.packages.filter((x) => x.architecture === arch);
if (selected.length !== 26)
	throw Error("complete architecture closure required");
for (const pkg of selected) {
	const current = installed.find(
		(line) =>
			line.startsWith(`${pkg.name}-`) &&
			/^\d/.test(line.slice(pkg.name.length + 1)),
	);
	if (!current) continue;
	const version = current.slice(pkg.name.length + 1);
	if (!/^[0-9][A-Za-z0-9._+~-]*-r[0-9]+$/.test(version))
		throw Error("unrecognised installed version");
	const comparison = execFileSync(
		"apk",
		["version", "-t", version, pkg.version],
		{ encoding: "utf8" },
	).trim();
	if (!["<", "="].includes(comparison))
		throw Error(`package downgrade refused: ${pkg.name}`);
}
for (const path of [
	"/opt/app/node_modules/.bin/zero-cache",
	"/usr/local/bin/litestream",
	"/usr/local/bin/litestream-v5",
	"/etc/litestream.yml",
	"/opt/app/verify.mjs",
]) {
	if (!existsSync(path)) throw Error("qualified Zero asset missing");
}
