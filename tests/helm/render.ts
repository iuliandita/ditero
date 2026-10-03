import assert from "node:assert/strict";
import { resolve } from "node:path";

type Manifest = {
	kind: string;
	metadata: {
		name: string;
		namespace: string;
		annotations?: Record<string, string>;
	};
	spec: {
		replicas?: number;
		strategy?: { type: string };
		selector?: { matchLabels: Record<string, string> };
		storageClassName?: string;
		rules?: {
			host: string;
			http: { paths: { backend: { service: { name: string } } }[] };
		}[];
		tls?: { hosts: string[]; secretName: string }[];
		template?: {
			metadata: { labels: Record<string, string> };
			spec: {
				automountServiceAccountToken: boolean;
				securityContext: {
					runAsNonRoot: boolean;
					runAsUser: number;
					fsGroup: number;
					seccompProfile: { type: string };
				};
				containers: {
					image: string;
					env: { name: string; value: string }[];
					securityContext: {
						readOnlyRootFilesystem: boolean;
						allowPrivilegeEscalation: boolean;
						capabilities: { drop: string[] };
					};
					startupProbe: { httpGet: { path: string } };
					readinessProbe: { httpGet: { path: string } };
					livenessProbe: { httpGet: { path: string } };
					resources: {
						requests: { cpu: string; memory: string };
						limits: { cpu: string; memory: string };
					};
					volumeMounts: {
						name: string;
						mountPath: string;
						readOnly?: boolean;
					}[];
				}[];
				volumes: {
					name: string;
					persistentVolumeClaim?: { claimName: string };
					secret?: {
						secretName: string;
						items: { key: string; path: string }[];
					};
				}[];
			};
		};
	};
};

const chart = resolve(import.meta.dir, "../../deploy/helm/ditero");
function template(...overrides: string[]) {
	return Bun.spawnSync([
		"helm",
		"template",
		"household",
		chart,
		"--namespace",
		"ditero-test",
		...overrides.flatMap((value) => ["--set", value]),
	]);
}
function render(...overrides: string[]): Manifest[] {
	const result = template(...overrides);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout
		.toString()
		.split(/^---\s*$/m)
		.filter((document) => document.trim())
		.map((document) => Bun.YAML.parse(document) as Manifest);
}
function deployment(manifests: Manifest[], component: string) {
	const manifest = manifests.find(
		(item) =>
			item.kind === "Deployment" &&
			item.metadata.name.endsWith(`-${component}`),
	);
	assert.ok(manifest?.spec.template);
	return manifest;
}

const defaults = render();
assert.deepEqual(defaults.map((item) => item.kind).sort(), [
	"Deployment",
	"Deployment",
	"PersistentVolumeClaim",
	"PersistentVolumeClaim",
	"Service",
	"Service",
]);
for (const manifest of defaults)
	assert.equal(manifest.metadata.namespace, "ditero-test");
for (const manifest of defaults.filter(
	(item) => item.kind === "PersistentVolumeClaim",
))
	assert.equal(
		manifest.metadata.annotations?.["helm.sh/resource-policy"],
		"keep",
	);
for (const component of ["app", "zero"]) {
	const manifest = deployment(defaults, component);
	const pod = manifest.spec.template;
	assert.ok(pod);
	const container = pod.spec.containers[0];
	assert.equal(manifest.spec.replicas, 1);
	assert.equal(manifest.spec.strategy?.type, "Recreate");
	for (const [key, value] of Object.entries(
		manifest.spec.selector?.matchLabels ?? {},
	)) {
		assert.equal(pod.metadata.labels[key], value);
	}
	assert.equal(pod.spec.automountServiceAccountToken, false);
	assert.equal(pod.spec.securityContext.runAsNonRoot, true);
	assert.equal(pod.spec.securityContext.runAsUser, 1000);
	assert.equal(pod.spec.securityContext.fsGroup, 1000);
	assert.equal(pod.spec.securityContext.seccompProfile.type, "RuntimeDefault");
	assert.equal(container.securityContext.readOnlyRootFilesystem, true);
	assert.equal(container.securityContext.allowPrivilegeEscalation, false);
	assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
	assert.ok(
		container.resources.requests.cpu && container.resources.requests.memory,
	);
	assert.ok(
		container.resources.limits.cpu && container.resources.limits.memory,
	);
	const suffix = component === "zero" ? "-zero" : "";
	assert.equal(
		container.image,
		`ghcr.io/iuliandita/ditero:0.0.1-alpha.1${suffix}`,
	);
	const endpoint = component === "app" ? "/health" : "/keepalive";
	for (const probe of [
		container.startupProbe,
		container.readinessProbe,
		container.livenessProbe,
	]) {
		assert.equal(probe.httpGet.path, endpoint);
	}
	const expectedKeys =
		component === "app"
			? [
					"DATABASE_URL",
					"DATABASE_MIGRATION_URL",
					"BETTER_AUTH_SECRET",
					"DITERO_ENCRYPTION_KEY",
				]
			: ["ZERO_UPSTREAM_DB", "ZERO_ADMIN_PASSWORD"];
	const secret = pod.spec.volumes.find(
		(volume) => volume.name === "secrets",
	)?.secret;
	assert.equal(secret?.secretName, "ditero-secrets");
	assert.deepEqual(
		secret?.items.map((item) => item.key),
		expectedKeys,
	);
	for (const key of expectedKeys) {
		assert.equal(
			container.env.find((item) => item.name === `${key}_FILE`)?.value,
			`/run/secrets/ditero/${key}`,
		);
		assert.equal(
			container.env.some((item) => item.name === key),
			false,
		);
	}
	assert.equal(
		container.volumeMounts.find((mount) => mount.name === "secrets")?.readOnly,
		true,
	);
	assert.equal(
		container.volumeMounts.find((mount) => mount.name === "data")?.mountPath,
		component === "app" ? "/data/attachments" : "/data",
	);
}
const zeroEnv = deployment(defaults, "zero").spec.template?.spec.containers[0]
	.env;
assert.equal(
	zeroEnv?.find((item) => item.name === "ZERO_QUERY_URL")?.value,
	"http://household-ditero-app:3000/api/zero/query",
);
assert.equal(
	zeroEnv?.find((item) => item.name === "ZERO_MUTATE_URL")?.value,
	"http://household-ditero-app:3000/api/zero/mutate",
);
assert.equal(
	zeroEnv?.find((item) => item.name === "ZERO_ENABLE_CRUD_MUTATIONS")?.value,
	"false",
);
assert.equal(
	zeroEnv?.find((item) => item.name === "ZERO_NUM_SYNC_WORKERS")?.value,
	"1",
);

const ingressOverrides = [
	"app.publicUrl=https://tasks.example.com",
	"app.publicZeroUrl=https://sync.example.com",
	"app.ingress.enabled=true",
	"app.ingress.host=tasks.example.com",
	"app.ingress.tlsSecretName=tasks-tls",
	"zero.ingress.enabled=true",
	"zero.ingress.host=sync.example.com",
	"zero.ingress.tlsSecretName=sync-tls",
];
const routed = render(...ingressOverrides);
const appEnv = deployment(routed, "app").spec.template?.spec.containers[0].env;
assert.equal(
	appEnv?.find((item) => item.name === "BETTER_AUTH_URL")?.value,
	"https://tasks.example.com",
);
assert.equal(
	appEnv?.find((item) => item.name === "PUBLIC_ZERO_URL")?.value,
	"https://sync.example.com",
);
const ingresses = routed.filter((item) => item.kind === "Ingress");
assert.equal(ingresses.length, 2);
for (const [index, host] of [
	"tasks.example.com",
	"sync.example.com",
].entries()) {
	const ingress = ingresses.find((item) => item.spec.rules?.[0].host === host);
	assert.ok(ingress);
	assert.deepEqual(ingress.spec.tls?.[0].hosts, [host]);
	assert.equal(
		ingress.spec.rules?.[0].http.paths[0].backend.service.name,
		`household-ditero-${index === 0 ? "app" : "zero"}`,
	);
}
assert.equal(
	render(
		"app.ingress.enabled=true",
		"app.ingress.host=tasks.example.com",
	).filter((item) => item.kind === "Ingress").length,
	1,
);
assert.equal(
	render(
		"zero.ingress.enabled=true",
		"zero.ingress.host=sync.example.com",
	).filter((item) => item.kind === "Ingress").length,
	1,
);

const reused = render(
	"app.persistence.existingClaim=attachments",
	"zero.persistence.existingClaim=replica",
);
assert.equal(
	reused.some((item) => item.kind === "PersistentVolumeClaim"),
	false,
);
for (const [component, claim] of [
	["app", "attachments"],
	["zero", "replica"],
]) {
	assert.equal(
		deployment(reused, component).spec.template?.spec.volumes.find(
			(volume) => volume.name === "data",
		)?.persistentVolumeClaim?.claimName,
		claim,
	);
}
const digest = `sha256:${"a".repeat(64)}`;
assert.equal(
	deployment(render(`app.image.digest=${digest}`), "app").spec.template?.spec
		.containers[0].image,
	`ghcr.io/iuliandita/ditero@${digest}`,
);
const noClass = render("app.persistence.storageClass=-").find(
	(item) =>
		item.kind === "PersistentVolumeClaim" &&
		item.metadata.name.endsWith("-app"),
);
assert.equal(noClass?.spec.storageClassName, "");
for (const invalid of [
	"existingSecret=",
	"app.ingress.enabled=true",
	"zero.ingress.enabled=true",
	"app.image.tag=latest",
	"app.registrationMode=invite",
	"zero.syncWorkers=0",
]) {
	assert.notEqual(
		template(invalid).exitCode,
		0,
		`accepted invalid configuration: ${invalid}`,
	);
}
console.log(
	"Helm rendering passed: default, both/single Ingress, existing claims, digest, storage class, six invalid configurations.",
);
