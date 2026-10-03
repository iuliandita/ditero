import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Probe = {
	httpGet: { path: string; port: string };
	periodSeconds: number;
	timeoutSeconds: number;
	failureThreshold?: number;
};
type Container = {
	name: string;
	image: string;
	env: { name: string; value: string }[];
	envFrom?: { configMapRef?: { name: string }; secretRef?: { name: string } }[];
	ports: { name: string; containerPort: number; protocol: string }[];
	securityContext: {
		readOnlyRootFilesystem: boolean;
		allowPrivilegeEscalation: boolean;
		privileged?: boolean;
		capabilities: { drop: string[]; add?: string[] };
	};
	startupProbe: Probe;
	readinessProbe: Probe;
	livenessProbe: Probe;
	resources: {
		requests: { cpu: string; memory: string; "ephemeral-storage": string };
		limits: { cpu: string; memory: string; "ephemeral-storage": string };
	};
	volumeMounts: { name: string; mountPath: string; readOnly?: boolean }[];
};
type Manifest = {
	apiVersion: string;
	kind: string;
	metadata: {
		name: string;
		namespace?: string;
		labels?: Record<string, string>;
	};
	data?: Record<string, string>;
	spec: {
		replicas?: number;
		strategy?: { type: string };
		selector?: Record<string, string> & {
			matchLabels?: Record<string, string>;
		};
		type?: string;
		ports?: {
			name: string;
			port: number;
			targetPort: string;
			protocol: string;
		}[];
		accessModes?: string[];
		resources?: { requests: { storage: string } };
		template?: {
			metadata: { labels: Record<string, string> };
			spec: {
				automountServiceAccountToken: boolean;
				hostNetwork?: boolean;
				hostPID?: boolean;
				hostIPC?: boolean;
				securityContext: {
					runAsNonRoot: boolean;
					runAsUser: number;
					runAsGroup: number;
					fsGroup: number;
					seccompProfile: { type: string };
				};
				containers: Container[];
				initContainers?: Container[];
				volumes: {
					name: string;
					persistentVolumeClaim?: { claimName: string };
					secret?: {
						secretName: string;
						defaultMode: number;
						items: { key: string; path: string }[];
					};
					emptyDir?: { sizeLimit: string };
					hostPath?: unknown;
				}[];
			};
		};
	};
};
const base = resolve(
	process.argv[2] ?? join(import.meta.dir, "../../deploy/kustomize/base"),
);
function render(path: string): Manifest[] {
	const result = Bun.spawnSync(["kubectl", "kustomize", path]);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout
		.toString()
		.split(/^---\s*$/m)
		.filter((document) => document.trim())
		.map((document) => Bun.YAML.parse(document) as Manifest);
}
function component(
	manifests: Manifest[],
	kind: string,
	name: string,
): Manifest {
	const found = manifests.filter(
		(item) =>
			item.kind === kind &&
			item.metadata.labels?.["app.kubernetes.io/component"] === name,
	);
	assert.equal(found.length, 1, `Expected one ${kind} for ${name}`);
	return found[0];
}
function pod(manifests: Manifest[], name: string) {
	const deployment = component(manifests, "Deployment", name);
	assert.ok(deployment.spec.template);
	assert.equal(deployment.spec.template.spec.containers.length, 1);
	return {
		deployment,
		template: deployment.spec.template,
		container: deployment.spec.template.spec.containers[0],
	};
}
function env(container: Container, name: string): string {
	const matches = container.env.filter((item) => item.name === name);
	assert.equal(matches.length, 1, `Expected one ${name}`);
	return matches[0].value;
}
function bindings(manifests: Manifest[], namespace: string) {
	assert.deepEqual(manifests.map((item) => item.kind).sort(), [
		"ConfigMap",
		"Deployment",
		"Deployment",
		"Namespace",
		"PersistentVolumeClaim",
		"PersistentVolumeClaim",
		"Service",
		"Service",
	]);
	const namespaces = manifests.filter((item) => item.kind === "Namespace");
	assert.equal(namespaces.length, 1);
	assert.equal(namespaces[0].metadata.name, namespace);
	assert.equal(namespaces[0].metadata.namespace, undefined);
	for (const mode of ["enforce", "audit", "warn"])
		assert.equal(
			namespaces[0].metadata.labels?.[`pod-security.kubernetes.io/${mode}`],
			"restricted",
		);
	for (const manifest of manifests.filter((item) => item.kind !== "Namespace"))
		assert.equal(manifest.metadata.namespace, namespace);
	const config = manifests.find((item) => item.kind === "ConfigMap");
	assert.ok(config?.data);
	assert.match(config.metadata.name, /ditero-app-config-[a-z0-9]+$/);
	assert.deepEqual(Object.keys(config.data).sort(), [
		"BETTER_AUTH_URL",
		"DITERO_REGISTRATION_MODE",
		"PUBLIC_ZERO_URL",
	]);
	for (const name of ["app", "zero"]) {
		const { deployment, template, container } = pod(manifests, name);
		const spec = template.spec;
		assert.equal(deployment.apiVersion, "apps/v1");
		assert.equal(deployment.spec.replicas, 1);
		assert.equal(deployment.spec.strategy?.type, "Recreate");
		assert.equal(container.name, name);
		assert.equal(spec.automountServiceAccountToken, false);
		assert.equal(spec.hostNetwork ?? false, false);
		assert.equal(spec.hostPID ?? false, false);
		assert.equal(spec.hostIPC ?? false, false);
		assert.equal(spec.initContainers?.length ?? 0, 0);
		assert.equal(spec.securityContext.runAsNonRoot, true);
		assert.equal(spec.securityContext.runAsUser, 1000);
		assert.equal(spec.securityContext.runAsGroup, 1000);
		assert.equal(spec.securityContext.fsGroup, 1000);
		assert.equal(spec.securityContext.seccompProfile.type, "RuntimeDefault");
		assert.equal(container.securityContext.readOnlyRootFilesystem, true);
		assert.equal(container.securityContext.allowPrivilegeEscalation, false);
		assert.equal(container.securityContext.privileged ?? false, false);
		assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
		assert.equal(container.securityContext.capabilities.add?.length ?? 0, 0);
		assert.ok(
			container.resources.requests.cpu && container.resources.requests.memory,
		);
		assert.ok(
			container.resources.limits.cpu && container.resources.limits.memory,
		);
		assert.equal(container.resources.requests["ephemeral-storage"], "64Mi");
		assert.equal(container.resources.limits["ephemeral-storage"], "512Mi");
		const port = name === "app" ? 3000 : 4848;
		assert.deepEqual(container.ports, [
			{ name: "http", containerPort: port, protocol: "TCP" },
		]);
		for (const probe of [
			container.startupProbe,
			container.readinessProbe,
			container.livenessProbe,
		]) {
			assert.deepEqual(probe.httpGet, {
				path: name === "app" ? "/health" : "/keepalive",
				port: "http",
			});
			assert.ok(probe.periodSeconds > 0 && probe.timeoutSeconds > 0);
		}
		assert.equal(container.startupProbe.failureThreshold, 120);
		const service = component(manifests, "Service", name);
		assert.equal(service.spec.type, "ClusterIP");
		assert.deepEqual(service.spec.ports, [
			{ name: "http", port, targetPort: "http", protocol: "TCP" },
		]);
		assert.deepEqual(
			deployment.spec.selector?.matchLabels,
			service.spec.selector,
		);
		assert.ok(service.spec.selector);
		for (const [key, value] of Object.entries(service.spec.selector))
			assert.equal(template.metadata.labels[key], value);
		const claim = component(manifests, "PersistentVolumeClaim", name);
		assert.deepEqual(claim.spec.accessModes, ["ReadWriteOnce"]);
		assert.equal(claim.spec.resources?.requests.storage, "10Gi");
		const data = spec.volumes.find((volume) => volume.name === "data");
		assert.equal(data?.persistentVolumeClaim?.claimName, claim.metadata.name);
		assert.deepEqual(spec.volumes.map((volume) => volume.name).sort(), [
			"data",
			"secrets",
			"tmp",
		]);
		assert.ok(spec.volumes.every((volume) => volume.hostPath === undefined));
		assert.equal(
			spec.volumes.find((volume) => volume.name === "tmp")?.emptyDir?.sizeLimit,
			"256Mi",
		);
		assert.equal(
			container.volumeMounts.find((mount) => mount.name === "data")?.mountPath,
			name === "app" ? "/data/attachments" : "/data",
		);
		assert.equal(
			container.volumeMounts.find((mount) => mount.name === "tmp")?.mountPath,
			"/tmp",
		);
		assert.deepEqual(
			container.volumeMounts.find((mount) => mount.name === "secrets"),
			{ name: "secrets", mountPath: "/run/secrets/ditero", readOnly: true },
		);
		const keys =
			name === "app"
				? [
						"DATABASE_URL",
						"DATABASE_MIGRATION_URL",
						"BETTER_AUTH_SECRET",
						"DITERO_ENCRYPTION_KEY",
					]
				: ["ZERO_UPSTREAM_DB", "ZERO_ADMIN_PASSWORD"];
		const secret = spec.volumes.find(
			(volume) => volume.name === "secrets",
		)?.secret;
		assert.equal(secret?.secretName, "ditero-secrets");
		assert.equal(secret?.defaultMode, 0o440);
		assert.deepEqual(
			secret?.items,
			keys.map((key) => ({ key, path: key })),
		);
		assert.equal(
			container.envFrom?.some((item) => item.secretRef) ?? false,
			false,
		);
		assert.deepEqual(
			container.env
				.filter((item) => item.name.endsWith("_FILE"))
				.map((item) => item.name)
				.sort(),
			keys
				.map((key) => `${key}_FILE`)
				.concat(name === "zero" ? ["ZERO_REPLICA_FILE"] : [])
				.sort(),
		);
		for (const key of keys) {
			assert.equal(env(container, `${key}_FILE`), `/run/secrets/ditero/${key}`);
			assert.equal(
				container.env.some((item) => item.name === key),
				false,
			);
		}
		if (name === "app") {
			assert.deepEqual(container.envFrom, [
				{ configMapRef: { name: config.metadata.name } },
			]);
			assert.equal(
				env(container, "DITERO_ATTACHMENT_STORAGE_DRIVER"),
				"filesystem",
			);
			assert.equal(
				env(container, "DITERO_ATTACHMENT_FS_PATH"),
				"/data/attachments",
			);
		} else {
			assert.equal(container.envFrom, undefined);
			assert.equal(
				env(container, "DITERO_APP_SERVICE"),
				component(manifests, "Service", "app").metadata.name,
				"Zero callback must follow transformed app Service name",
			);
			assert.equal(
				env(container, "ZERO_QUERY_URL"),
				"http://$(DITERO_APP_SERVICE):3000/api/zero/query",
			);
			assert.equal(
				env(container, "ZERO_MUTATE_URL"),
				"http://$(DITERO_APP_SERVICE):3000/api/zero/mutate",
			);
			assert.ok(
				container.env.findIndex((item) => item.name === "DITERO_APP_SERVICE") <
					container.env.findIndex((item) => item.name === "ZERO_QUERY_URL"),
			);
			assert.equal(env(container, "ZERO_ENABLE_CRUD_MUTATIONS"), "false");
			assert.equal(env(container, "ZERO_NUM_SYNC_WORKERS"), "1");
			assert.equal(env(container, "ZERO_REPLICA_FILE"), "/data/replica.db");
		}
	}
	return config;
}
const defaults = render(base);
const defaultConfig = bindings(defaults, "ditero");
const defaultImage = pod(defaults, "app").container.image;
assert.match(
	defaultImage,
	/^ghcr\.io\/iuliandita\/ditero:\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/,
);
assert.equal(pod(defaults, "zero").container.image, `${defaultImage}-zero`);
assert.equal(defaultConfig.data?.BETTER_AUTH_URL, "http://localhost:3000");
assert.equal(defaultConfig.data?.PUBLIC_ZERO_URL, "http://localhost:4848");
assert.equal(defaultConfig.data?.DITERO_REGISTRATION_MODE, "bootstrap");
const temporary = await mkdtemp(join(tmpdir(), "ditero-kustomize-"));
try {
	await cp(base, join(temporary, "base"), { recursive: true });
	await mkdir(join(temporary, "overlay"));
	const overlay = join(temporary, "overlay");
	await writeFile(
		join(overlay, "kustomization.yaml"),
		`apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- ../base
namespace: household
namePrefix: home-
images:
- name: ghcr.io/iuliandita/ditero
  newName: docker.io/iuliandita/ditero
  newTag: 0.0.2-alpha.1
configMapGenerator:
- name: ditero-app-config
  behavior: merge
  literals:
  - BETTER_AUTH_URL=https://tasks.example.com
  - PUBLIC_ZERO_URL=https://sync.example.com
  - DITERO_REGISTRATION_MODE=closed
patches:
- target:
    kind: Deployment
    name: ditero-zero
  patch: |-
    - op: replace
      path: /spec/template/spec/containers/0/image
      value: docker.io/iuliandita/ditero:0.0.2-alpha.1-zero
`,
	);
	const configured = render(overlay);
	const config = bindings(configured, "household");
	assert.notEqual(config.metadata.name, defaultConfig.metadata.name);
	assert.ok(
		configured
			.filter((item) => item.kind !== "Namespace")
			.every((item) => item.metadata.name.startsWith("home-")),
	);
	assert.equal(
		pod(configured, "app").container.image,
		"docker.io/iuliandita/ditero:0.0.2-alpha.1",
	);
	assert.equal(
		pod(configured, "zero").container.image,
		"docker.io/iuliandita/ditero:0.0.2-alpha.1-zero",
	);
	assert.deepEqual(config.data, {
		BETTER_AUTH_URL: "https://tasks.example.com",
		PUBLIC_ZERO_URL: "https://sync.example.com",
		DITERO_REGISTRATION_MODE: "closed",
	});
} finally {
	await rm(temporary, { recursive: true, force: true });
}
console.log(
	"Kustomize rendering passed: default bindings/security and renamed namespace/image/config overlay.",
);
