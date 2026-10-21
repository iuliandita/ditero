import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { background, freePort, run, state, until } from "./stack.ts";

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

export async function systemBrowser() {
	const port = await freePort();
	const profile = resolve(state, "browser-profile");
	const chrome =
		process.platform === "win32"
			? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
			: process.platform === "darwin"
				? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
				: "/usr/bin/google-chrome";
	const args = [
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		"--no-first-run",
		"--no-default-browser-check",
	];
	const browser = background("system-browser", chrome, [
		...args,
		"about:blank",
	]);
	await until(
		"system browser CDP",
		async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok,
	);
	if (process.platform === "win32") {
		const script = resolve(state, "private/browser-handler.ps1");
		writeFileSync(
			script,
			`$ErrorActionPreference='Stop'\n$command='"${chrome}" ${args.map((arg) => `"${arg}"`).join(" ")} "%1"'\n$choice=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice' -ErrorAction SilentlyContinue\n$ids=@('https','http','MSEdgeHTM','ChromeHTML','DiteroJourneyBrowser')\nif ($choice) { $ids += $choice.ProgId }\nforeach($id in $ids) { $key="HKCU:\\Software\\Classes\\$id\\shell\\open\\command"; New-Item $key -Force | Out-Null; Set-Item $key -Value $command }\n`,
		);
		run("pwsh", ["-NoProfile", "-File", script]);
	} else if (process.platform === "darwin") {
		const source = resolve(state, "private/browser.applescript");
		const wrapper = resolve(state, "private/Journey Browser.app");
		const command = `${shellQuote(chrome)} ${args.map(shellQuote).join(" ")} `;
		writeFileSync(
			source,
			`on open location address\n do shell script ${JSON.stringify(command)} & quoted form of address & " >/dev/null 2>&1 &"\nend open location\n`,
		);
		run("osacompile", ["-o", wrapper, source]);
		run("python3", [
			"-c",
			"import pathlib,plistlib,sys; p=pathlib.Path(sys.argv[1]); d=plistlib.loads(p.read_bytes()); d.update(CFBundleIdentifier='io.ditero.journey-browser',CFBundleURLTypes=[{'CFBundleURLSchemes':['https']}]); p.write_bytes(plistlib.dumps(d))",
			`${wrapper}/Contents/Info.plist`,
		]);
		run("codesign", ["--force", "--sign", "-", wrapper]);
		run(
			"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
			["-f", wrapper],
		);
		const swift = resolve(state, "private/browser.swift");
		writeFileSync(
			swift,
			'import Foundation\nimport CoreServices\nlet status = LSSetDefaultHandlerForURLScheme("https" as CFString, "io.ditero.journey-browser" as CFString)\nif status != noErr { fatalError("Default browser registration failed") }\n',
		);
		run("swift", [swift]);
	} else {
		const wrapper = resolve(state, "private/browser.sh");
		writeFileSync(
			wrapper,
			`#!/bin/sh\nexec ${shellQuote(chrome)} ${args.map(shellQuote).join(" ")} "$@"\n`,
			{ mode: 0o700 },
		);
		const directory = resolve(
			process.env.HOME ?? "",
			".local/share/applications",
		);
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			resolve(directory, "ditero-journey-browser.desktop"),
			`[Desktop Entry]\nName=Journey browser\nType=Application\nExec="${wrapper}" %u\nMimeType=x-scheme-handler/https;\n`,
		);
		run("xdg-mime", [
			"default",
			"ditero-journey-browser.desktop",
			"x-scheme-handler/https",
		]);
		process.env.BROWSER = wrapper;
	}
	const connection = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	const context = connection.contexts()[0];
	if (!context) throw new Error("missing system browser context");
	return {
		context,
		async consent(origin: string, email: string, password: string) {
			// The page must have been opened by the native host, never by page.goto().
			const page = await until("native system-browser handoff", () =>
				context
					.pages()
					.find((page) =>
						page.url().startsWith(`${origin}/native/authorize?grantId=`),
					),
			);
			await page
				.getByTestId("email")
				.or(page.getByTestId("native-authorize"))
				.waitFor();
			if (await page.getByTestId("email").isVisible()) {
				await page.getByTestId("email").fill(email);
				await page.getByTestId("password").fill(password);
				await page.getByTestId("signin").click();
			}
			await page
				.getByRole("button", { name: "Allow this device", exact: true })
				.click();
			await page.getByTestId("native-authorize-approved").waitFor();
			await page.screenshot({
				path: resolve(state, "evidence/browser-consent.png"),
			});
		},
		async close() {
			await connection.close();
			browser.kill();
		},
	};
}
