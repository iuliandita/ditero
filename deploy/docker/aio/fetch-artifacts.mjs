// Build-only official downloads. Never runs services or reads runtime secrets.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [arch, out] = process.argv.slice(2);
const alpine = { amd64: "x86_64", arm64: "aarch64" }[arch];
if (!alpine || !out) throw Error("supported architecture and output required");
const lock = JSON.parse(
	readFileSync(new URL("packages.lock.json", import.meta.url)),
);
async function fetchPinned(url, sha, path) {
	const u = new URL(url);
	if (
		u.protocol !== "https:" ||
		!["dl-cdn.alpinelinux.org", "alpinelinux.org"].includes(u.hostname)
	)
		throw Error("official artifact URL required");
	const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
	if (!response.ok) throw Error("artifact unavailable");
	const bytes = Buffer.from(await response.arrayBuffer());
	if (createHash("sha256").update(bytes).digest("hex") !== sha)
		throw Error("artifact hash mismatch");
	writeFileSync(path, bytes);
}
for (const dir of [out, `${out}/apks`, `${out}/keys`])
	mkdirSync(dir, { recursive: true });
for (const key of lock.keys)
	await fetchPinned(key.url, key.sha256, `${out}/keys/${key.key}`);
for (const pkg of lock.packages.filter((x) => x.architecture === alpine))
	await fetchPinned(
		pkg.url,
		pkg.sha256,
		`${out}/apks/${pkg.name}-${pkg.version}.apk`,
	);
