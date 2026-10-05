import { describe, expect, test } from "vitest";
import {
	allocatePorts,
	apiProxyTarget,
	assertDistinctPorts,
	assertEmptyInventory,
	type ContainerRecord,
	cleanupSteps,
	confirmIdentity,
	DEFAULT_API_PROXY_TARGET,
	emptyInventory,
	hostEnvironment,
	type Inventory,
	inspectArgv,
	listArgv,
	loopbackPort,
	mergeOwned,
	NETWORK_LABEL,
	type NetworkRecord,
	newRun,
	originFor,
	ownedInventory,
	type PortBinder,
	type PortHold,
	PROJECT_LABEL,
	parseIds,
	parsePort,
	parseRecords,
	planCleanup,
	portOf,
	RUN_LABEL,
	SERVICE_LABEL,
	StackOwnershipError,
	VOLUME_LABEL,
	type VolumeRecord,
} from "./e2e-stack.ts";

const run = newRun();
const other = newRun();
const hex = (seed: string) => seed.repeat(64).slice(0, 64);

function container(
	service: string,
	seed: string,
	labels: Record<string, string> = {},
): ContainerRecord {
	return {
		id: hex(seed),
		created: "2026-10-05T10:00:00Z",
		labels: {
			[PROJECT_LABEL]: run.project,
			[RUN_LABEL]: run.runId,
			[SERVICE_LABEL]: service,
			...labels,
		},
	};
}
function volume(
	suffix: string,
	labels: Record<string, string> = {},
	name = `${run.project}_${suffix}`,
): VolumeRecord {
	return {
		name,
		created: "2026-10-05T10:00:01Z",
		labels: {
			[PROJECT_LABEL]: run.project,
			[RUN_LABEL]: run.runId,
			[VOLUME_LABEL]: suffix,
			...labels,
		},
	};
}
function network(
	labels: Record<string, string> = {},
	name = `${run.project}_default`,
	seed = "e",
): NetworkRecord {
	return {
		id: hex(seed),
		name,
		created: "2026-10-05T10:00:02Z",
		labels: {
			[PROJECT_LABEL]: run.project,
			[RUN_LABEL]: run.runId,
			[NETWORK_LABEL]: "default",
			...labels,
		},
	};
}
function stack(): Inventory {
	return {
		containers: [container("upstream-db", "a"), container("zero-cache", "b")],
		volumes: [volume("zero-data")],
		networks: [network()],
	};
}
const withContainer = (record: ContainerRecord): Inventory => ({
	...emptyInventory(),
	containers: [record],
});
const withVolume = (record: VolumeRecord): Inventory => ({
	...emptyInventory(),
	volumes: [record],
});
const withNetwork = (record: NetworkRecord): Inventory => ({
	...emptyInventory(),
	networks: [record],
});
const owned = (inventory: Inventory, isolated = false) =>
	ownedInventory(inventory, run, isolated);

describe("newRun", () => {
	test("generates a unique identity whose project embeds the run", () => {
		const runs = Array.from({ length: 50 }, () => newRun());
		expect(new Set(runs.map((item) => item.runId)).size).toBe(50);
		expect(new Set(runs.map((item) => item.project)).size).toBe(50);
		expect(run.runId).toMatch(/^[0-9a-f-]{36}$/);
		expect(run.project).toBe(`ditero-e2e-${run.runId.replaceAll("-", "")}`);
	});
	test("refuses an identity the runner did not generate", () => {
		const fixed = { runId: "unmanaged", project: "ditero-e2e" };
		expect(() => ownedInventory(emptyInventory(), fixed, false)).toThrow(
			"generated per-run identity",
		);
		expect(() =>
			ownedInventory(
				emptyInventory(),
				{ runId: run.runId, project: "ditero-e2e" },
				false,
			),
		).toThrow("generated per-run identity");
	});
});

describe("ownedInventory", () => {
	test("accepts the exact owned stack", () => {
		const inventory = stack();
		expect(owned(inventory)).toEqual(inventory);
	});
	test("accepts an empty inventory, as after a failed build", () => {
		expect(owned(emptyInventory())).toEqual(emptyInventory());
	});
	test("ignores resources related to neither project nor marker", () => {
		const unrelated = withContainer({
			id: hex("c"),
			created: "x",
			labels: { [PROJECT_LABEL]: "ditero-e2e", [SERVICE_LABEL]: "zero-cache" },
		});
		expect(owned(unrelated)).toEqual(emptyInventory());
	});
	test("permits the browser only in isolated mode", () => {
		const inventory = withContainer(container("browser", "d"));
		expect(owned(inventory, true)).toEqual(inventory);
		expect(() => owned(inventory)).toThrow("allowed E2E service");
	});
	test("refuses a missing run marker on the run's project", () => {
		const labels = container("zero-cache", "b").labels;
		const { [RUN_LABEL]: _marker, ...unmarked } = labels;
		expect(() =>
			owned(
				withContainer({ ...container("zero-cache", "b"), labels: unmarked }),
			),
		).toThrow("run marker missing or differs");
	});
	test("refuses a foreign container in the same project", () => {
		expect(() =>
			owned({
				...stack(),
				containers: [
					...stack().containers,
					container("zero-cache", "c", { [RUN_LABEL]: other.runId }),
				],
			}),
		).toThrow("container cccccccccccc: run marker missing or differs");
	});
	test.each([
		"minio",
		"minio-init",
		"",
		"zero-cache-2",
	])("refuses service %j", (service) => {
		expect(() => owned(withContainer(container(service, "b")))).toThrow(
			"allowed E2E service",
		);
	});
	test("refuses a missing service label", () => {
		const { [SERVICE_LABEL]: _service, ...labels } = container("x", "b").labels;
		expect(() =>
			owned(withContainer({ ...container("x", "b"), labels })),
		).toThrow("allowed E2E service");
	});
	test("refuses the run marker under a different project", () => {
		expect(() =>
			owned(
				withContainer(
					container("zero-cache", "b", { [PROJECT_LABEL]: other.project }),
				),
			),
		).toThrow("project label differs");
		expect(() =>
			owned(withVolume(volume("zero-data", { [PROJECT_LABEL]: "ditero-e2e" }))),
		).toThrow("project label differs");
		expect(() =>
			owned(withNetwork(network({ [PROJECT_LABEL]: other.project }))),
		).toThrow("project label differs");
	});
	test("refuses a short container or network ID", () => {
		expect(() =>
			owned(withContainer({ ...container("zero-cache", "b"), id: "abc123" })),
		).toThrow("full container ID");
		expect(() => owned(withNetwork({ ...network(), id: "abc123" }))).toThrow(
			"full network ID",
		);
	});
	test.each([
		["another name", volume("zero-data", {}, `${other.project}_zero-data`)],
		["an unexpected suffix", volume("zero-data", {}, `${run.project}_extra`)],
		[
			"a wrong Compose volume label",
			volume("zero-data", { [VOLUME_LABEL]: "minio-data" }),
		],
		["no Compose volume label", volume("zero-data", { [VOLUME_LABEL]: "" })],
		[
			"a different run marker",
			volume("zero-data", { [RUN_LABEL]: other.runId }),
		],
	])("refuses a volume with %s", (_name, record) => {
		expect(() => owned(withVolume(record))).toThrow(StackOwnershipError);
	});
	test("accepts all three expected volume names", () => {
		const inventory = {
			...emptyInventory(),
			volumes: [
				volume("zero-data"),
				volume("minio-data"),
				volume("postgres-data"),
			],
		};
		expect(owned(inventory)).toEqual(inventory);
	});
	test.each([
		["another name", network({}, `${run.project}_other`)],
		["a wrong Compose network label", network({ [NETWORK_LABEL]: "other" })],
		["a different run marker", network({ [RUN_LABEL]: other.runId })],
	])("refuses a network with %s", (_name, record) => {
		expect(() => owned(withNetwork(record))).toThrow(StackOwnershipError);
	});
	test("reports every problem and returns nothing when one row is bad", () => {
		const inventory = stack();
		inventory.containers.push(container("minio", "c"));
		inventory.volumes.push(volume("zero-data", {}, `${run.project}_bad`));
		try {
			owned(inventory);
			expect.unreachable();
		} catch (error) {
			expect((error as StackOwnershipError).problems).toHaveLength(2);
		}
	});
});

describe("assertEmptyInventory", () => {
	test("passes when nothing relates to the run", () => {
		expect(() => assertEmptyInventory(emptyInventory(), run)).not.toThrow();
	});
	test.each([
		[
			"a project-labelled container",
			withContainer(container("zero-cache", "b", { [RUN_LABEL]: other.runId })),
		],
		[
			"a marker-only volume",
			withVolume(volume("zero-data", { [PROJECT_LABEL]: other.project })),
		],
		["a default network", withNetwork(network())],
	])("refuses to adopt %s", (_name, inventory) => {
		expect(() => assertEmptyInventory(inventory, run)).toThrow(
			"refusing to adopt",
		);
	});
});

describe("mergeOwned and planCleanup", () => {
	const input = (
		overrides: Partial<Parameters<typeof planCleanup>[0]> = {},
	) => ({
		run,
		isolatedBrowser: false,
		upAttempted: true,
		tracked: emptyInventory(),
		current: stack(),
		...overrides,
	});
	test("plans an owned stack, dependants first", () => {
		const plan = planCleanup(input());
		expect(plan.containers.map((item) => item.labels[SERVICE_LABEL])).toEqual([
			"zero-cache",
			"upstream-db",
		]);
	});
	test("an empty owned inventory is safe with or without a started stack", () => {
		for (const upAttempted of [false, true])
			expect(
				planCleanup(input({ upAttempted, current: emptyInventory() })),
			).toEqual(emptyInventory());
	});
	test("refuses alien resources when no stack was started", () => {
		expect(() => planCleanup(input({ upAttempted: false }))).toThrow(
			"never started a stack",
		);
		expect(() =>
			planCleanup(
				input({
					upAttempted: false,
					current: withContainer(
						container("zero-cache", "b", { [RUN_LABEL]: other.runId }),
					),
				}),
			),
		).toThrow(StackOwnershipError);
	});
	test("refuses the whole plan when any related row is foreign", () => {
		const current = stack();
		current.containers.push(
			container("zero-cache", "c", { [RUN_LABEL]: other.runId }),
		);
		expect(() => planCleanup(input({ current }))).toThrow(StackOwnershipError);
	});
	test("accepts resources first seen at cleanup after a partial up", () => {
		const tracked = withContainer(container("upstream-db", "a"));
		expect(planCleanup(input({ tracked })).containers).toHaveLength(2);
	});
	test("tolerates a tracked resource that has disappeared", () => {
		expect(
			mergeOwned(stack(), withContainer(container("upstream-db", "a"))),
		).toEqual(withContainer(container("upstream-db", "a")));
	});
	test.each([
		[
			"container",
			withContainer({ ...container("upstream-db", "a"), created: "other" }),
		],
		["volume", withVolume({ ...volume("zero-data"), created: "other" })],
		["network", withNetwork({ ...network(), id: hex("f") })],
		[
			"container labels",
			withContainer(container("upstream-db", "a", { extra: "1" })),
		],
	])("refuses drifted %s identity", (_name, current) => {
		expect(() => mergeOwned(stack(), current)).toThrow("identity changed");
	});
});

describe("confirmIdentity", () => {
	const expected = container("zero-cache", "b");
	const confirm = (actual: ContainerRecord | undefined) =>
		confirmIdentity("containers", expected, actual, run, false);
	test("accepts the unchanged resource", () => {
		expect(() => confirm({ ...expected })).not.toThrow();
	});
	test("refuses a resource that vanished, was relabelled, or was replaced", () => {
		expect(() => confirm(undefined)).toThrow("no longer present");
		expect(() =>
			confirm(container("zero-cache", "b", { [RUN_LABEL]: other.runId })),
		).toThrow("run marker");
		expect(() => confirm({ ...expected, id: hex("c") })).toThrow(
			"identity changed",
		);
		expect(() => confirm({ ...expected, created: "later" })).toThrow(
			"identity changed",
		);
	});
	test("checks volumes and networks the same way", () => {
		expect(() =>
			confirmIdentity(
				"volumes",
				volume("zero-data"),
				volume("zero-data"),
				run,
				false,
			),
		).not.toThrow();
		expect(() =>
			confirmIdentity(
				"volumes",
				volume("zero-data"),
				volume("zero-data", { [VOLUME_LABEL]: "minio-data" }),
				run,
				false,
			),
		).toThrow(StackOwnershipError);
		expect(() =>
			confirmIdentity(
				"networks",
				network(),
				{ ...network(), id: hex("f") },
				run,
				false,
			),
		).toThrow("identity changed");
	});
});

describe("cleanupSteps", () => {
	test("emits only exact, non-forced writes in dependency order", () => {
		const steps = cleanupSteps(
			planCleanup({
				run,
				isolatedBrowser: false,
				upAttempted: true,
				tracked: emptyInventory(),
				current: stack(),
			}),
		);
		expect(steps.map((step) => step.argv)).toEqual([
			["stop", "--time", "10", hex("b")],
			["rm", hex("b")],
			["stop", "--time", "10", hex("a")],
			["rm", hex("a")],
			["volume", "rm", `${run.project}_zero-data`],
			["network", "rm", hex("e")],
		]);
		const forbidden = [
			"-f",
			"--force",
			"-v",
			"--volumes",
			"down",
			"prune",
			"--remove-orphans",
			"kill",
		];
		for (const step of steps) {
			expect(step.argv.some((arg) => forbidden.includes(arg))).toBe(false);
			expect(step.timeoutMs).toBeGreaterThan(0);
		}
	});
	test("an empty plan writes nothing", () => {
		expect(cleanupSteps(emptyInventory())).toEqual([]);
	});
});

describe("docker output parsing", () => {
	test("builds read-only list and inspect argv with a selected format", () => {
		expect(listArgv("containers", "k=v")).toEqual([
			"ps",
			"--all",
			"--quiet",
			"--no-trunc",
			"--filter",
			"label=k=v",
		]);
		expect(inspectArgv("volumes", ["n"]).slice(0, 2)).toEqual([
			"volume",
			"inspect",
		]);
		for (const kind of ["containers", "volumes", "networks"] as const) {
			const format = inspectArgv(kind, ["x"])[
				inspectArgv(kind, ["x"]).indexOf("--format") + 1
			];
			expect(format).not.toMatch(/Env|\.Config\}|json \.\}/);
		}
	});
	test("parses IDs and rejects truncated or unexpected output", () => {
		expect(
			parseIds(`${hex("a")}\n${hex("a")}\n\n${hex("b")}\n`, /^[a-f0-9]{64}$/),
		).toEqual([hex("a"), hex("b")]);
		expect(() => parseIds("abc123\n", /^[a-f0-9]{64}$/)).toThrow("unexpected");
		expect(parseIds("", /^x$/)).toEqual([]);
	});
	test("parses records and null labels, rejects malformed rows", () => {
		const line = JSON.stringify({ id: hex("a"), created: "t", labels: null });
		expect(parseRecords("containers", `${line}\n`)).toEqual([
			{ id: hex("a"), created: "t", labels: {} },
		]);
		expect(
			parseRecords("volumes", '{"name":"n","created":"t","labels":{"a":"b"}}'),
		).toEqual([{ name: "n", created: "t", labels: { a: "b" } }]);
		for (const bad of [
			"not json",
			"[]",
			'{"id":"","created":"t","labels":{}}',
			'{"id":"a","created":"t","labels":{"a":1}}',
		])
			expect(() => parseRecords("containers", bad)).toThrow("Malformed");
	});
});

describe("ports", () => {
	test("loopbackPort accepts one loopback binding", () => {
		expect(loopbackPort("127.0.0.1:43219\n")).toBe(43219);
	});
	test.each([
		"",
		"127.0.0.1:0",
		"127.0.0.1:65536",
		"127.0.0.1:043219",
		"0.0.0.0:43219",
		"[::1]:43219",
		"127.0.0.1:43219\n127.0.0.1:43220",
		"127.0.0.1:43219/other",
	])("loopbackPort rejects %j", (binding) => {
		expect(() => loopbackPort(binding)).toThrow("one loopback");
	});
	test.each([
		"",
		"0",
		"65536",
		"-1",
		"1.5",
		"80a",
		"٣",
	])("parsePort rejects %j", (value) => {
		expect(() => parsePort(value, "PORT")).toThrow("PORT requires a TCP port");
	});
	test("portOf requires a valid explicit origin port", () => {
		expect(portOf("http://localhost:5173", "WEB")).toBe(5173);
		expect(() => portOf("http://localhost", "WEB")).toThrow("explicit port");
		expect(() => portOf("http://localhost:80", "WEB")).toThrow("explicit port");
		expect(() => portOf("not a url", "WEB")).toThrow("valid origin");
		expect(() => portOf("", "WEB")).toThrow("valid origin");
	});
	test("originFor validates the port", () => {
		expect(originFor(5173)).toBe("http://localhost:5173");
		expect(originFor(4599, "172.17.0.1")).toBe("http://172.17.0.1:4599");
		for (const port of [0, 65536, -1, 1.5, Number.NaN])
			expect(() => originFor(port)).toThrow("TCP port");
	});
	test("hostEnvironment derives every origin from the reserved ports", () => {
		expect(
			hostEnvironment(
				{
					api: 41000,
					web: 41001,
					mail: 41002,
					smtp: 41003,
					smtpHttp: 41004,
					ntfy: 41005,
				},
				"172.17.0.1",
			),
		).toEqual({
			DITERO_E2E_API_PORT: "41000",
			E2E_WEB_URL: "http://localhost:41001",
			E2E_API_URL: "http://localhost:41000",
			E2E_MAIL_API_URL: "http://localhost:41002",
			E2E_NTFY_URL: "http://172.17.0.1:41005",
			E2E_SMTP_HTTP_URL: "http://127.0.0.1:41004",
			E2E_SMTP_PORT: "41003",
		});
		expect(() =>
			hostEnvironment(
				{ api: 0, web: 1, mail: 2, smtp: 3, smtpHttp: 4, ntfy: 5 },
				"h",
			),
		).toThrow("TCP port");
	});
	test("assertDistinctPorts names the colliding services", () => {
		expect(() => assertDistinctPorts({ db: 1, zero: 2, api: 3 })).not.toThrow();
		expect(() => assertDistinctPorts({ db: 1, zero: 2, api: 2 })).toThrow(
			"zero and api collide",
		);
		expect(() => assertDistinctPorts({ db: 0 })).toThrow("TCP port");
	});
});

describe("allocatePorts", () => {
	function fakeBinder(ports: number[]) {
		const events: string[] = [];
		const bound: string[] = [];
		const bind: PortBinder = async (host) => {
			const port = ports.shift();
			if (port === undefined) throw new Error("bind failed");
			events.push(`bind ${host}:${port}`);
			bound.push(host);
			const hold: PortHold = {
				port,
				close: async () => void events.push(`close ${port}`),
			};
			return hold;
		};
		return { bind, events, bound };
	}
	const requests = [
		{ name: "api", host: "127.0.0.1" },
		{ name: "ntfy", host: "172.17.0.1" },
		{ name: "web", host: "127.0.0.1" },
	] as const;

	test("holds every bind until all picks finish, then releases them", async () => {
		const { bind, events, bound } = fakeBinder([41000, 41001, 41002]);
		await expect(allocatePorts(requests, bind)).resolves.toEqual({
			api: 41000,
			ntfy: 41001,
			web: 41002,
		});
		expect(bound).toEqual(["127.0.0.1", "172.17.0.1", "127.0.0.1"]);
		expect(events.slice(0, 3).every((event) => event.startsWith("bind"))).toBe(
			true,
		);
		expect(events.slice(3).every((event) => event.startsWith("close"))).toBe(
			true,
		);
		expect(events).toHaveLength(6);
	});
	test("redraws a port that duplicates a pick or a reserved Docker port", async () => {
		const { bind, events } = fakeBinder([41000, 41000, 42000, 41002, 41003]);
		await expect(allocatePorts(requests, bind, [42000])).resolves.toEqual({
			api: 41000,
			ntfy: 41002,
			web: 41003,
		});
		expect(events.filter((event) => event.startsWith("close"))).toHaveLength(5);
	});
	test("fails loudly when no distinct port can be had and still releases", async () => {
		const { bind, events } = fakeBinder(
			Array.from({ length: 40 }, () => 41000),
		);
		await expect(allocatePorts(requests, bind)).rejects.toThrow(
			"Cannot reserve a distinct ntfy port",
		);
		expect(events.filter((event) => event.startsWith("close"))).toHaveLength(
			events.filter((event) => event.startsWith("bind")).length,
		);
	});
	test("a bind failure keeps its error and releases earlier reservations", async () => {
		const { bind, events } = fakeBinder([41000]);
		await expect(allocatePorts(requests, bind)).rejects.toThrow("bind failed");
		expect(events).toEqual(["bind 127.0.0.1:41000", "close 41000"]);
	});
	test("a release failure is reported, not ignored", async () => {
		const bind: PortBinder = async () => ({
			port: 41000,
			close: async () => {
				throw new Error("close failed");
			},
		});
		await expect(
			allocatePorts([{ name: "api", host: "127.0.0.1" }], bind),
		).rejects.toThrow("Cannot release reserved E2E ports");
	});
	test("rejects an invalid reported port", async () => {
		const bind: PortBinder = async () => ({ port: 0, close: async () => {} });
		await expect(
			allocatePorts([{ name: "api", host: "127.0.0.1" }], bind),
		).rejects.toThrow("TCP port");
	});
});

describe("apiProxyTarget", () => {
	const test_ = (E2E_API_URL: string | undefined) => ({
		NODE_ENV: "test",
		E2E_API_URL,
	});
	test("keeps the development default outside NODE_ENV=test", () => {
		for (const NODE_ENV of [undefined, "development", "production"])
			expect(
				apiProxyTarget({ NODE_ENV, E2E_API_URL: "http://localhost:41000" }),
			).toBe(DEFAULT_API_PROXY_TARGET);
		expect(
			apiProxyTarget({
				NODE_ENV: "development",
				E2E_API_URL: "https://evil.test/x",
			}),
		).toBe(DEFAULT_API_PROXY_TARGET);
	});
	test("keeps the default in test mode without an override", () => {
		expect(apiProxyTarget(test_(undefined))).toBe(DEFAULT_API_PROXY_TARGET);
		expect(apiProxyTarget(test_(""))).toBe(DEFAULT_API_PROXY_TARGET);
	});
	test.each([
		["http://localhost:41000", "http://localhost:41000"],
		["http://127.0.0.1:41000/", "http://127.0.0.1:41000"],
		["http://[::1]:41000", "http://[::1]:41000"],
	])("follows a loopback HTTP origin %s in test mode", (value, expected) => {
		expect(apiProxyTarget(test_(value))).toBe(expected);
	});
	test.each([
		"http://example.test:3000",
		"http://10.0.0.5:3000",
		"http://0.0.0.0:3000",
		"http://localhost.example.test:3000",
		"http://user:secret@localhost:3000",
		"http://localhost:3000/api",
		"http://localhost:3000?x=1",
		"http://localhost:3000/#frag",
		"https://localhost:3000",
		"ws://localhost:3000",
		"ftp://localhost:3000",
		"http://localhost",
		"not a url",
	])("refuses %j in test mode", (value) => {
		expect(() => apiProxyTarget(test_(value))).toThrow(
			/loopback HTTP origin|explicit port/,
		);
	});
});
