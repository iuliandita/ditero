import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

class ReleaseError extends Error {}

type Environment = Record<string, string | undefined>;
type Platform = "linux" | "windows" | "macos";
const hosts = { linux: "linux", windows: "win32", macos: "darwin" };
const bundles = { linux: "deb,appimage", windows: "nsis", macos: "app,dmg" };
const required = (env: Environment, name: string): string => {
	const value = env[name];
	if (!value || value !== value.trim() || /[\r\n\0]/.test(value))
		throw new ReleaseError(`Missing or invalid ${name}`);
	return value;
};

export function releasePlan(platform: string, host: string, env: Environment) {
	if (!(platform in hosts) || !Object.hasOwn(hosts, platform))
		throw new ReleaseError("Expected linux, windows, or macos");
	const target = platform as Platform;
	if (hosts[target] !== host)
		throw new ReleaseError("Release target must match the build host");
	if (env.TAURI_CONFIG)
		throw new ReleaseError("TAURI_CONFIG must be unset for release hooks");
	const version = required(env, "DITERO_RELEASE_VERSION");
	if (
		!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
			version,
		)
	)
		throw new ReleaseError(
			"DITERO_RELEASE_VERSION must be a semantic version without a v prefix",
		);
	const bundle: Record<string, unknown> = {
		targets: bundles[target].split(","),
		shortDescription: "Ditero desktop",
		createUpdaterArtifacts: false,
	};
	if (target === "windows") {
		const thumbprint = required(env, "DITERO_WINDOWS_CERTIFICATE_THUMBPRINT");
		if (!/^[0-9A-Fa-f]{40}$/.test(thumbprint))
			throw new ReleaseError("Invalid Windows certificate thumbprint");
		const timestamp = new URL(required(env, "DITERO_WINDOWS_TIMESTAMP_URL"));
		if (
			timestamp.protocol !== "https:" ||
			timestamp.username ||
			timestamp.password ||
			timestamp.hash
		)
			throw new ReleaseError(
				"Timestamp service must use trusted HTTPS without credentials or a fragment",
			);
		bundle.windows = {
			certificateThumbprint: thumbprint.toUpperCase(),
			digestAlgorithm: "sha256",
			timestampUrl: timestamp.href,
			tsp: true,
		};
	}
	if (target === "macos") {
		const identity = required(env, "APPLE_SIGNING_IDENTITY");
		if (!/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(identity))
			throw new ReleaseError(
				"A Developer ID Application signing identity is required",
			);
		// Use an already imported certificate; no automatic certificate import.
		if (env.APPLE_CERTIFICATE || env.APPLE_CERTIFICATE_PASSWORD)
			throw new ReleaseError("Import the certificate before using this hook");
		required(env, "APPLE_API_KEY");
		required(env, "APPLE_API_ISSUER");
		required(env, "APPLE_API_KEY_PATH");
		if (env.APPLE_ID || env.APPLE_PASSWORD || env.APPLE_TEAM_ID)
			throw new ReleaseError(
				"Use only App Store Connect API notarization credentials with this hook",
			);
		bundle.macOS = { signingIdentity: identity, hardenedRuntime: true };
	}
	return {
		target,
		config: { version, bundle },
		argv: ["build", "--bundles", bundles[target], "--", "--locked"],
	};
}

function command(
	program: string,
	args: string[],
	cwd: string,
	env: Environment,
): string {
	const result = spawnSync(program, args, {
		cwd,
		env,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	// Signing tools can include private identity/configuration in diagnostics.
	if (result.error || result.status !== 0) {
		const directory = privateDirectory("ditero-release-failure-");
		const log = join(directory, "command.log");
		writeFileSync(
			log,
			`${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`,
			{ mode: 0o600 },
		);
		throw new ReleaseError(
			`Release command failed; private diagnostics: ${log}`,
		);
	}
	return result.stdout;
}

export function releaseArgv(configPath: string, argv: string[]): string[] {
	return [argv[0], "--config", configPath, ...argv.slice(1)];
}

function privateDirectory(prefix: string): string {
	const temporary = mkdtempSync(join(tmpdir(), prefix));
	try {
		if (process.platform === "win32") {
			const result = spawnSync(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"$ErrorActionPreference='Stop'; $acl = New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:DITERO_RELEASE_TEMP_DIRECTORY -AclObject $acl",
				],
				{
					cwd: temporary,
					env: { ...process.env, DITERO_RELEASE_TEMP_DIRECTORY: temporary },
					encoding: "utf8",
					maxBuffer: 1024 * 1024,
				},
			);
			if (result.error || result.status !== 0)
				throw new ReleaseError("Private release directory setup failed");
		} else chmodSync(temporary, 0o700);
		return temporary;
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		throw error;
	}
}

export function withReleaseConfig<T>(
	config: unknown,
	run: (path: string) => T,
): T {
	const temporary = privateDirectory("ditero-release-");
	try {
		const path = join(temporary, "release.json");
		writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
		return run(path);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

export function main(
	args = process.argv.slice(2),
	env: Environment = process.env,
) {
	if (args.length !== 1)
		throw new ReleaseError("Expected exactly one release platform");
	const plan = releasePlan(args[0], process.platform, env);
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const desktop = join(root, "apps/desktop");
	const cliPackage = JSON.parse(
		readFileSync(
			join(desktop, "node_modules/@tauri-apps/cli/package.json"),
			"utf8",
		),
	) as { version: string };
	if (cliPackage.version !== "2.12.1")
		throw new ReleaseError("Expected the pinned Tauri CLI 2.12.1");
	if (plan.target === "windows") {
		const certificate = command(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"$c = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Thumbprint -eq $env:DITERO_WINDOWS_CERTIFICATE_THUMBPRINT -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) -and $_.NotBefore -lt (Get-Date) -and ($_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3') }; if (@($c).Count -ne 1) { exit 1 }; 'ready'",
			],
			desktop,
			env,
		);
		if (certificate.trim() !== "ready")
			throw new ReleaseError("Installed signing certificate unavailable");
	}
	if (plan.target === "macos") {
		const identities = command(
			"security",
			["find-identity", "-v", "-p", "codesigning"],
			desktop,
			env,
		);
		if (!identities.includes(`"${env.APPLE_SIGNING_IDENTITY}"`))
			throw new ReleaseError("Installed signing identity unavailable");
		const key = statSync(required(env, "APPLE_API_KEY_PATH"));
		if (!key.isFile() || (key.mode & 0o077) !== 0)
			throw new ReleaseError("Notarization key must be a private regular file");
	}
	withReleaseConfig(plan.config, (configPath) => {
		command(process.execPath, ["run", "build"], desktop, env);
		command(
			process.execPath,
			["run", "tauri", ...releaseArgv(configPath, plan.argv)],
			desktop,
			env,
		);
	});
	console.log(
		`Desktop ${plan.target} release build completed; installation and signature qualification remain required.`,
	);
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		console.error(
			error instanceof ReleaseError ? error.message : "Desktop release failed",
		);
		process.exitCode = 1;
	}
}
