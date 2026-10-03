import release from "../../release.json";

declare const DITERO_CLIENT_BUILD: {
	version: string;
	sourceSha: string;
	sourceDirty: boolean;
	bunVersion: string;
	bunRevision: string;
	target: string;
};

export const clientBuild = Object.freeze(
	typeof DITERO_CLIENT_BUILD === "undefined"
		? {
				version: release.version,
				sourceSha: "development",
				sourceDirty: true,
				bunVersion: "source",
				bunRevision: "source",
				target: "source",
			}
		: DITERO_CLIENT_BUILD,
);

export function clientVersion(name: string): string {
	return `${name} ${clientBuild.version} (${clientBuild.sourceSha}${clientBuild.sourceDirty ? "+modified" : ""}; ${clientBuild.target})\n`;
}
