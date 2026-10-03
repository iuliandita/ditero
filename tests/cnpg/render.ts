import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type ObjectRow = {
	kind: string;
	metadata: { name: string; namespace?: string };
	spec?: {
		instances: number;
		enableSuperuserAccess: boolean;
		bootstrap: {
			initdb: {
				secret: { name: string };
				postInitApplicationSQLRefs: {
					configMapRefs: { name: string; key: string }[];
				};
			};
		};
		managed: {
			roles: {
				name: string;
				superuser: boolean;
				bypassrls?: boolean;
				inherit: boolean;
				passwordSecret: { name: string };
			}[];
		};
	};
	data?: Record<string, string>;
};

function render(path: string): ObjectRow[] {
	const result = Bun.spawnSync(["kubectl", "kustomize", path]);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout
		.toString()
		.split(/^---\s*$/m)
		.filter((row) => row.trim())
		.map((row) => Bun.YAML.parse(row) as ObjectRow);
}

function bindings(rows: ObjectRow[], namespace: string, prefix: string) {
	assert.equal(rows.length, 10);
	assert.equal(rows.filter((row) => row.kind === "Secret").length, 0);
	assert.ok(
		rows
			.filter((row) => row.kind !== "Namespace")
			.every((row) => row.metadata.namespace === namespace),
	);
	const cluster = rows.find((row) => row.kind === "Cluster");
	assert.equal(cluster?.metadata.name, `${prefix}ditero-db`);
	assert.ok(cluster?.spec);
	assert.equal(cluster.spec.instances, 1);
	assert.equal(cluster.spec.enableSuperuserAccess, false);
	const init = cluster.spec.bootstrap.initdb;
	assert.equal(init.secret.name, "ditero-db-migrator");
	const refs = init.postInitApplicationSQLRefs.configMapRefs;
	assert.equal(refs.length, 1);
	const config = rows.find((row) => row.metadata.name === refs[0].name);
	assert.equal(config?.kind, "ConfigMap");
	assert.ok(config?.data?.[refs[0].key].includes("CREATE SCHEMA zero_0"));
	assert.ok(refs[0].name.startsWith(`${prefix}ditero-db-bootstrap-`));
	const runtime = cluster.spec.managed.roles.find(
		(role) => role.name === "ditero_runtime",
	);
	assert.equal(runtime?.superuser, false);
	assert.equal(runtime?.bypassrls, false);
	assert.equal(runtime?.inherit, false);
	assert.equal(runtime?.passwordSecret.name, "ditero-db-runtime");
	const zero = cluster.spec.managed.roles.find(
		(role) => role.name === "ditero_zero",
	);
	assert.equal(zero?.superuser, true);
	assert.equal(zero?.passwordSecret.name, "ditero-db-zero");
}

const root = resolve(
	process.argv[2] ?? join(import.meta.dir, "../../deploy/kustomize"),
);
bindings(render(join(root, "cnpg")), "ditero", "");
const temporary = await mkdtemp(join(tmpdir(), "ditero-cnpg-render-"));
try {
	await cp(root, join(temporary, "kustomize"), { recursive: true });
	await writeFile(
		join(temporary, "kustomization.yaml"),
		"apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n- kustomize/cnpg\nnamespace: household\nnamePrefix: home-\n",
	);
	bindings(render(temporary), "household", "home-");
} finally {
	await rm(temporary, { recursive: true, force: true });
}
console.log("CloudNativePG default and renamed bootstrap bindings passed.");
