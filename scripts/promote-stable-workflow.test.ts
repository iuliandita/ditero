import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const workflow = readFileSync(".github/workflows/promote-stable.yml", "utf8");

function stepText(name: string): string {
	const marker = `      - name: ${name}\n`;
	const start = workflow.indexOf(marker);
	if (start < 0) throw new Error(`missing step: ${name}`);
	const next = workflow.indexOf("\n      - ", start + marker.length);
	return workflow.slice(start, next < 0 ? undefined : next);
}

describe("stable image promotion", () => {
	test("promotes the zero-cache manifest in both registries", () => {
		const run = stepText("Retag manifests as :stable");
		expect(run).toContain(
			`docker buildx imagetools create --tag "\${GHCR_IMAGE}:stable-zero" "\${GHCR_IMAGE}:\${version}-zero"`,
		);
		expect(run).toContain(
			`docker buildx imagetools create --tag "\${DOCKER_IMAGE}:stable-zero" "\${DOCKER_IMAGE}:\${version}-zero"`,
		);
	});

	test("resolves and signs both promoted digests", () => {
		const digest = stepText("Resolve promoted digests");
		expect(digest).toContain(`"\${GHCR_IMAGE}:stable-zero"`);
		expect(digest).toContain('echo "app=$app" >> "$GITHUB_OUTPUT"');
		expect(digest).toContain('echo "zero=$zero" >> "$GITHUB_OUTPUT"');

		const sign = stepText("Sign :stable images (cosign keyless)");
		expect(sign).toContain(`APP_DIGEST: \${{ steps.digest.outputs.app }}`);
		expect(sign).toContain(`ZERO_DIGEST: \${{ steps.digest.outputs.zero }}`);
		for (const command of [
			`cosign sign --yes "\${GHCR_IMAGE}@\${APP_DIGEST}"`,
			`cosign sign --yes "\${DOCKER_IMAGE}@\${APP_DIGEST}"`,
			`cosign sign --yes "\${GHCR_IMAGE}@\${ZERO_DIGEST}"`,
			`cosign sign --yes "\${DOCKER_IMAGE}@\${ZERO_DIGEST}"`,
		]) {
			expect(sign).toContain(command);
		}
	});
});
