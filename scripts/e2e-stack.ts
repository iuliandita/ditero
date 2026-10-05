import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

// Pure ownership, port, and proxy guards for the browser E2E stack (#834).
// tests/e2e/run.ts does the Docker I/O; everything it must decide lives here so
// the refusals can be tested without Docker.

export const RUN_LABEL = "io.ditero.e2e.run";
export const PROJECT_LABEL = "com.docker.compose.project";
export const SERVICE_LABEL = "com.docker.compose.service";
export const VOLUME_LABEL = "com.docker.compose.volume";
export const NETWORK_LABEL = "com.docker.compose.network";

export const FULL_ID = /^[a-f0-9]{64}$/;
export const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// Stop order: dependants first.
const SERVICES = ["browser", "zero-cache", "upstream-db"] as const;
const VOLUMES = ["zero-data", "minio-data", "postgres-data"] as const;

export type E2ERun = Readonly<{ runId: string; project: string }>;

export function newRun(): E2ERun {
	const runId = randomUUID();
	return { runId, project: `ditero-e2e-${runId.replaceAll("-", "")}` };
}

function assertRun(run: E2ERun) {
	if (
		!RUN_ID.test(run.runId) ||
		run.project !== `ditero-e2e-${run.runId.replaceAll("-", "")}`
	)
		throw new Error("E2E run identity is not a generated per-run identity");
}

// --- Inventory -------------------------------------------------------------

export type Labels = Readonly<Record<string, string>>;
export type ContainerRecord = {
	id: string;
	created: string;
	labels: Labels;
};
export type VolumeRecord = { name: string; created: string; labels: Labels };
export type NetworkRecord = {
	id: string;
	name: string;
	created: string;
	labels: Labels;
};
export type AnyRecord = ContainerRecord | VolumeRecord | NetworkRecord;
export type Inventory = {
	containers: ContainerRecord[];
	volumes: VolumeRecord[];
	networks: NetworkRecord[];
};
export type InventoryKind = keyof Inventory;

export function emptyInventory(): Inventory {
	return { containers: [], volumes: [], networks: [] };
}

export class StackOwnershipError extends Error {
	readonly problems: readonly string[];
	constructor(problems: readonly string[]) {
		super(`E2E stack ownership check failed: ${problems.join("; ")}`);
		this.name = "StackOwnershipError";
		this.problems = problems;
	}
}

// Select identity fields only: full inspect output carries process environment.
const INSPECT_FORMAT: Record<InventoryKind, string> = {
	containers:
		'{"id":{{json .Id}},"created":{{json .Created}},"labels":{{json .Config.Labels}}}',
	volumes:
		'{"name":{{json .Name}},"created":{{json .CreatedAt}},"labels":{{json .Labels}}}',
	networks:
		'{"id":{{json .Id}},"name":{{json .Name}},"created":{{json .Created}},"labels":{{json .Labels}}}',
};

export function listArgv(kind: InventoryKind, labelFilter: string): string[] {
	const filter = ["--filter", `label=${labelFilter}`];
	if (kind === "containers")
		return ["ps", "--all", "--quiet", "--no-trunc", ...filter];
	if (kind === "volumes") return ["volume", "ls", "--quiet", ...filter];
	return ["network", "ls", "--quiet", "--no-trunc", ...filter];
}

export function inspectArgv(kind: InventoryKind, keys: string[]): string[] {
	const base =
		kind === "containers"
			? ["inspect", "--type", "container"]
			: [kind === "volumes" ? "volume" : "network", "inspect"];
	return [...base, "--format", INSPECT_FORMAT[kind], ...keys];
}

export function parseIds(output: string, pattern: RegExp): string[] {
	const ids = output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (ids.some((id) => !pattern.test(id)))
		throw new Error("Docker listed an unexpected resource identifier");
	return [...new Set(ids)];
}

function text(value: unknown, what: string): string {
	if (typeof value !== "string" || !value)
		throw new Error(`Malformed Docker ${what} inspect output`);
	return value;
}

function labelMap(value: unknown, what: string): Labels {
	if (value === null) return {};
	if (typeof value !== "object" || Array.isArray(value))
		throw new Error(`Malformed Docker ${what} inspect labels`);
	const labels: Record<string, string> = {};
	for (const [key, label] of Object.entries(value as Record<string, unknown>)) {
		if (typeof label !== "string")
			throw new Error(`Malformed Docker ${what} inspect labels`);
		labels[key] = label;
	}
	return labels;
}

// One JSON object per line, as produced by the INSPECT_FORMAT templates.
export function parseRecords<K extends InventoryKind>(
	kind: K,
	output: string,
): Inventory[K] {
	const records = output
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			let row: unknown;
			try {
				row = JSON.parse(line);
			} catch {
				throw new Error(`Malformed Docker ${kind} inspect output`);
			}
			if (!row || typeof row !== "object" || Array.isArray(row))
				throw new Error(`Malformed Docker ${kind} inspect output`);
			const fields = row as Record<string, unknown>;
			const labels = labelMap(fields.labels, kind);
			const created = text(fields.created, kind);
			if (kind === "containers")
				return { id: text(fields.id, kind), created, labels };
			if (kind === "volumes")
				return { name: text(fields.name, kind), created, labels };
			return {
				id: text(fields.id, kind),
				name: text(fields.name, kind),
				created,
				labels,
			};
		});
	return records as unknown as Inventory[K];
}

function related(labels: Labels, run: E2ERun): boolean {
	return (
		labels[PROJECT_LABEL] === run.project || labels[RUN_LABEL] === run.runId
	);
}

function rows(inventory: Inventory): AnyRecord[] {
	return [...inventory.containers, ...inventory.volumes, ...inventory.networks];
}

function display(record: AnyRecord): string {
	return "id" in record ? record.id.slice(0, 12) : record.name;
}

function labelProblems(labels: Labels, run: E2ERun): string[] {
	const found: string[] = [];
	if (labels[PROJECT_LABEL] !== run.project)
		found.push("project label differs");
	if (labels[RUN_LABEL] !== run.runId)
		found.push("run marker missing or differs");
	return found;
}

// Validates every row related to this run -- by project label OR run marker --
// and returns them, or throws listing all problems. Rows related to neither are
// never owned and are left out. Callers act only on the returned records.
export function ownedInventory(
	inventory: Inventory,
	run: E2ERun,
	isolatedBrowser: boolean,
): Inventory {
	assertRun(run);
	const services = SERVICES.filter(
		(service) => isolatedBrowser || service !== "browser",
	);
	const problems: string[] = [];
	const owned = emptyInventory();
	for (const container of inventory.containers) {
		if (!related(container.labels, run)) continue;
		const found = [
			...(FULL_ID.test(container.id) ? [] : ["ID is not a full container ID"]),
			...labelProblems(container.labels, run),
			...(services.some(
				(service) => service === container.labels[SERVICE_LABEL],
			)
				? []
				: ["service is not an allowed E2E service"]),
		];
		if (found.length)
			problems.push(`container ${display(container)}: ${found.join(", ")}`);
		else owned.containers.push(container);
	}
	for (const volume of inventory.volumes) {
		if (!related(volume.labels, run)) continue;
		const suffix = VOLUMES.find(
			(candidate) => volume.name === `${run.project}_${candidate}`,
		);
		const found = [
			...(suffix ? [] : ["volume name is not an expected E2E volume"]),
			...labelProblems(volume.labels, run),
			...(suffix && volume.labels[VOLUME_LABEL] === suffix
				? []
				: ["Compose volume label differs"]),
		];
		if (found.length)
			problems.push(`volume ${display(volume)}: ${found.join(", ")}`);
		else owned.volumes.push(volume);
	}
	for (const network of inventory.networks) {
		if (!related(network.labels, run)) continue;
		const found = [
			...(FULL_ID.test(network.id) ? [] : ["ID is not a full network ID"]),
			...(network.name === `${run.project}_default`
				? []
				: ["network name is not the run's default network"]),
			...labelProblems(network.labels, run),
			...(network.labels[NETWORK_LABEL] === "default"
				? []
				: ["Compose network label differs"]),
		];
		if (found.length)
			problems.push(`network ${display(network)}: ${found.join(", ")}`);
		else owned.networks.push(network);
	}
	if (problems.length) throw new StackOwnershipError(problems);
	return owned;
}

// Run before the first `up`: anything already carrying this run's project or
// marker was not created by us and must not be adopted.
export function assertEmptyInventory(inventory: Inventory, run: E2ERun) {
	assertRun(run);
	const existing = rows(inventory).filter((row) => related(row.labels, run));
	if (existing.length)
		throw new StackOwnershipError([
			`${existing.length} resource(s) already carry this run's project or marker; refusing to adopt them`,
		]);
}

const byName = (a: [string, unknown], b: [string, unknown]) =>
	a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;

export function identityKey(record: AnyRecord): string {
	const { labels, ...rest } = record;
	return JSON.stringify([
		Object.entries(rest).sort(byName),
		Object.entries(labels).sort(byName),
	]);
}

function drift<T extends AnyRecord>(
	before: T[],
	after: T[],
	key: (record: T) => string,
	problems: string[],
) {
	const known = new Map(
		before.map((record) => [key(record), identityKey(record)]),
	);
	for (const record of after) {
		const seen = known.get(key(record));
		if (seen !== undefined && seen !== identityKey(record))
			problems.push(`${display(record)}: identity changed since creation`);
	}
}

// `tracked` is what earlier snapshots captured from our own creations; `current`
// is a freshly validated inventory. A tracked identity that changed in place is
// drift. A tracked resource that disappeared is simply gone.
export function mergeOwned(tracked: Inventory, current: Inventory): Inventory {
	const problems: string[] = [];
	drift(tracked.containers, current.containers, (r) => r.id, problems);
	drift(tracked.volumes, current.volumes, (r) => r.name, problems);
	drift(tracked.networks, current.networks, (r) => r.name, problems);
	if (problems.length) throw new StackOwnershipError(problems);
	return current;
}

export function planCleanup(input: {
	run: E2ERun;
	isolatedBrowser: boolean;
	upAttempted: boolean;
	tracked: Inventory;
	current: Inventory;
}): Inventory {
	const owned = ownedInventory(input.current, input.run, input.isolatedBrowser);
	if (!input.upAttempted && rows(owned).length)
		throw new StackOwnershipError([
			"resources carry this run's identity, but this runner never started a stack",
		]);
	const plan = mergeOwned(input.tracked, owned);
	const rank = (record: ContainerRecord) =>
		(SERVICES as readonly string[]).indexOf(record.labels[SERVICE_LABEL]);
	return {
		...plan,
		containers: [...plan.containers].sort((a, b) => rank(a) - rank(b)),
	};
}

// Immediate pre-write check against a fresh inspect of the one resource.
export function confirmIdentity(
	kind: InventoryKind,
	expected: AnyRecord,
	actual: AnyRecord | undefined,
	run: E2ERun,
	isolatedBrowser: boolean,
) {
	if (!actual)
		throw new StackOwnershipError([`${display(expected)}: no longer present`]);
	const single = emptyInventory();
	if (kind === "containers") single.containers.push(actual as ContainerRecord);
	else if (kind === "volumes") single.volumes.push(actual as VolumeRecord);
	else single.networks.push(actual as NetworkRecord);
	ownedInventory(single, run, isolatedBrowser);
	if (identityKey(expected) !== identityKey(actual))
		throw new StackOwnershipError([
			`${display(expected)}: identity changed since validation`,
		]);
}

export type CleanupStep = {
	kind: InventoryKind;
	record: AnyRecord;
	key: string;
	label: string;
	argv: string[];
	timeoutMs: number;
};

// Exact-ID writes only: no force, no `-v`, no `down`, no pruning.
export function cleanupSteps(plan: Inventory): CleanupStep[] {
	const steps: CleanupStep[] = [];
	for (const container of plan.containers)
		for (const [verb, argv, timeoutMs] of [
			["stop", ["stop", "--time", "10", container.id], 30_000],
			["rm", ["rm", container.id], 30_000],
		] as const)
			steps.push({
				kind: "containers",
				record: container,
				key: container.id,
				label: `${verb} container ${container.id.slice(0, 12)}`,
				argv: [...argv],
				timeoutMs,
			});
	for (const volume of plan.volumes)
		steps.push({
			kind: "volumes",
			record: volume,
			key: volume.name,
			label: `rm volume ${volume.name}`,
			argv: ["volume", "rm", volume.name],
			timeoutMs: 20_000,
		});
	for (const network of plan.networks)
		steps.push({
			kind: "networks",
			record: network,
			key: network.id,
			label: `rm network ${network.id.slice(0, 12)}`,
			argv: ["network", "rm", network.id],
			timeoutMs: 20_000,
		});
	return steps;
}

// --- Ports and origins -----------------------------------------------------

export function parsePort(value: string | undefined, label: string): number {
	if (!value || !/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535)
		throw new Error(`${label} requires a TCP port`);
	return Number(value);
}

// Docker `compose port` output for a published port, loopback only.
export function loopbackPort(binding: string): number {
	const match = /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(binding.trim());
	if (!match || Number(match[1]) > 65535)
		throw new Error("Expected one loopback E2E port binding");
	return Number(match[1]);
}

export function portOf(origin: string, label: string): number {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		throw new Error(`${label} requires a valid origin`);
	}
	if (!url.port) throw new Error(`${label} requires an explicit port`);
	return parsePort(url.port, label);
}

export function originFor(port: number, host = "localhost"): string {
	parsePort(String(port), "origin");
	return `http://${host}:${port}`;
}

export function assertDistinctPorts(ports: Readonly<Record<string, number>>) {
	const seen = new Map<number, string>();
	for (const [name, port] of Object.entries(ports)) {
		parsePort(String(port), `${name} port`);
		const other = seen.get(port);
		if (other) throw new Error(`E2E ports for ${other} and ${name} collide`);
		seen.set(port, name);
	}
}

export type PortHold = { port: number; close(): Promise<void> };
export type PortBinder = (host: string) => Promise<PortHold>;
const MAX_BIND_ATTEMPTS = 16;

export const bindEphemeral: PortBinder = (host) =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen({ host, port: 0, exclusive: true }, () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Cannot read the reserved E2E port"));
				return;
			}
			resolve({
				port: address.port,
				close: () =>
					new Promise<void>((done, fail) =>
						server.close((error) => (error ? fail(error) : done())),
					),
			});
		});
	});

// Every reservation stays bound until all picks are made, so the picks are
// distinct from each other and from `reserved` (ports Docker already owns).
// They are released afterwards: a race with another process is not hidden here;
// the consumers (strictPort, reuseExistingServer: false) fail loudly on it.
export async function allocatePorts<K extends string>(
	requests: readonly { name: K; host: string }[],
	bind: PortBinder,
	reserved: Iterable<number> = [],
): Promise<Record<K, number>> {
	const taken = new Set(reserved);
	const holds: PortHold[] = [];
	const picks = {} as Record<K, number>;
	let primaryFailure: unknown;
	let failed = false;
	try {
		for (const { name, host } of requests) {
			let port: number | undefined;
			for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS && !port; attempt++) {
				const hold = await bind(host);
				holds.push(hold);
				parsePort(String(hold.port), `${name} port`);
				if (!taken.has(hold.port)) {
					taken.add(hold.port);
					port = hold.port;
				}
			}
			if (!port) throw new Error(`Cannot reserve a distinct ${name} port`);
			picks[name] = port;
		}
	} catch (error) {
		failed = true;
		primaryFailure = error;
	}
	{
		const closed = await Promise.allSettled(holds.map((hold) => hold.close()));
		const releaseFailures = closed.filter(
			(result) => result.status === "rejected",
		);
		if (releaseFailures.length) {
			if (!failed) throw new Error("Cannot release reserved E2E ports");
			console.error("Cannot release reserved E2E ports");
		}
	}
	if (failed) throw primaryFailure;
	return picks;
}

export type HostPorts = Record<
	"api" | "web" | "mail" | "smtp" | "smtpHttp" | "ntfy",
	number
>;

// Environment the Playwright config and Compose read to learn the run's ports.
export function hostEnvironment(
	ports: HostPorts,
	ntfyHost: string,
): Record<string, string> {
	return {
		DITERO_E2E_API_PORT: String(ports.api),
		E2E_WEB_URL: originFor(ports.web),
		E2E_API_URL: originFor(ports.api),
		E2E_MAIL_API_URL: originFor(ports.mail),
		E2E_NTFY_URL: originFor(ports.ntfy, ntfyHost),
		E2E_SMTP_HTTP_URL: originFor(ports.smtpHttp, "127.0.0.1"),
		E2E_SMTP_PORT: String(parsePort(String(ports.smtp), "SMTP port")),
	};
}

// --- Vite proxy ------------------------------------------------------------

export const DEFAULT_API_PROXY_TARGET = "http://localhost:3000";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Only NODE_ENV=test may move the proxy, and only to a plain loopback origin.
export function apiProxyTarget(
	env: Readonly<Record<string, string | undefined>>,
): string {
	const value = env.E2E_API_URL;
	if (env.NODE_ENV !== "test" || !value) return DEFAULT_API_PROXY_TARGET;
	const refusal =
		"E2E_API_URL must be a loopback HTTP origin without credentials, path, query, or fragment";
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(refusal);
	}
	if (
		url.protocol !== "http:" ||
		!LOOPBACK_HOSTS.has(url.hostname) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error(refusal);
	portOf(url.origin, "E2E_API_URL");
	return url.origin;
}
