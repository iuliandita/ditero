import release from "../../release.json";

declare const DITERO_CLIENT_BUILD: {
	version: string;
	sourceSha: string;
	sourceDirty: boolean;
	target: string;
};

export const MINIMUM_BUN = "1.3.14";

export const clientBuild = Object.freeze(
	typeof DITERO_CLIENT_BUILD === "undefined"
		? {
				version: release.version,
				sourceSha: "development",
				sourceDirty: true,
				target: "source",
			}
		: DITERO_CLIENT_BUILD,
);

export function clientVersion(name: string): string {
	return `${JSON.stringify({
		name,
		version: clientBuild.version,
		commit: clientBuild.sourceSha,
		dirty: clientBuild.sourceDirty,
		target: clientBuild.target,
		minimumBun: MINIMUM_BUN,
		bun: process.versions.bun ?? null,
	})}\n`;
}

export function clientLabel(name: string): string {
	return `${name} ${clientBuild.version} (${clientBuild.sourceSha}${clientBuild.sourceDirty ? "+modified" : ""}; ${clientBuild.target})`;
}
