import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { background, evidence, freePort, run, state, until } from "./stack.ts";

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

function fixtureRequest(
	url: string,
	options: {
		method?: string;
		headers?: Record<string, string>;
		data?: unknown;
	} = {},
) {
	return new Promise<{
		status(): number;
		ok(): boolean;
		text(): Promise<string>;
	}>((done, fail) => {
		const body =
			options.data === undefined ? undefined : JSON.stringify(options.data);
		const request = httpsRequest(
			url,
			{
				method: options.method ?? "GET",
				ca: readFileSync(resolve(state, "ca.crt")),
				headers: {
					...(body
						? {
								"Content-Type": "application/json",
								"Content-Length": String(Buffer.byteLength(body)),
							}
						: {}),
					...options.headers,
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.on("error", fail);
				response.on("end", () => {
					const status = response.statusCode ?? 0;
					const text = Buffer.concat(chunks).toString("utf8");
					done({
						status: () => status,
						ok: () => status >= 200 && status < 300,
						text: async () => text,
					});
				});
			},
		);
		request.setTimeout(15000, () =>
			request.destroy(new Error("Verified fixture request timed out")),
		);
		request.on("error", fail);
		request.end(body);
	});
}

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
	const browser =
		process.platform === "darwin"
			? background("system-browser", "open", [
					"-a",
					"/Applications/Google Chrome.app",
					"--args",
					...args,
					"about:blank",
				])
			: background("system-browser", chrome, [...args, "about:blank"]);
	if (process.platform === "darwin") {
		writeFileSync(
			resolve(evidence, "browser-first-open.txt"),
			run(resolve(process.env.RUNNER_TEMP ?? "", "journey-browser"), []),
		);
	}

	await until(
		"system browser CDP",
		async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok,
	);
	const connection = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	const context = connection.contexts()[0];
	if (!context) throw new Error("missing system browser context");
	if (process.platform === "win32") {
		const script = resolve(state, "private/browser-handler.ps1");
		writeFileSync(
			script,
			`$ErrorActionPreference='Stop'\n$command='"${chrome}" ${args.map((arg) => `"${arg}"`).join(" ")} "%1"'\n$choice=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice' -ErrorAction SilentlyContinue\n$ids=@('https','http','MSEdgeHTM','ChromeHTML','DiteroJourneyBrowser')\nif ($choice) { $ids += $choice.ProgId }\nforeach($id in $ids) { $key="HKCU:\\Software\\Classes\\$id\\shell\\open\\command"; New-Item $key -Force | Out-Null; Set-Item $key -Value $command; New-ItemProperty $key -Name DelegateExecute -Value '' -PropertyType String -Force | Out-Null }\n`,
		);
		run("pwsh", ["-NoProfile", "-File", script]);
	} else if (process.platform === "darwin") {
		const settings = await context.newPage();
		await settings.goto("chrome://settings/defaultBrowser");
		const button = settings.getByRole("button", {
			name: "Make default",
			exact: true,
		});
		await button
			.or(
				settings.getByText("Google Chrome is your default browser", {
					exact: true,
				}),
			)
			.waitFor();
		if (await button.isVisible()) {
			await button.click();
			try {
				run("osascript", [
					"-e",
					`tell application "System Events"
repeat 60 times
try
tell process "CoreServicesUIAgent"
click (first button of window 1 whose name contains "Chrome" and name does not contain "Keep")
return
end tell
end try
delay 0.5
end repeat
error "Default browser confirmation was not available"
end tell`,
				]);
			} catch (error) {
				run("screencapture", [
					"-x",
					resolve(evidence, "browser-default-failed.png"),
				]);
				throw error;
			}
		}
		await settings.close();
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
			`[Desktop Entry]\nName=Journey browser\nType=Application\nExec=${wrapper} %u\nTerminal=false\nCategories=Network;WebBrowser;\nMimeType=x-scheme-handler/https;\n`,
		);
		run("xdg-mime", [
			"default",
			"ditero-journey-browser.desktop",
			"x-scheme-handler/https",
		]);
		process.env.BROWSER = wrapper;
	}
	return {
		context,
		request: {
			post: (
				url: string,
				options: { headers: Record<string, string>; data: unknown },
			) => fixtureRequest(url, { ...options, method: "POST" }),
		},
		async probe(origin: string) {
			const url = `${origin}/health`;
			const verified = await fixtureRequest(url);
			writeFileSync(
				resolve(evidence, "browser-handler-health.json"),
				JSON.stringify({
					status: verified.status(),
					body: await verified.text(),
				}),
			);
			if (!verified.ok())
				throw new Error("Verified HTTPS fixture health failed");
			context.on("requestfailed", (request) =>
				writeFileSync(
					resolve(evidence, "browser-request-failed.json"),
					JSON.stringify({
						url: request.url().split("?")[0],
						failure: request.failure(),
					}),
				),
			);
			try {
				if (process.platform === "darwin") run("open", [url]);
				else if (process.platform === "win32")
					run("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
				else run("xdg-open", [url]);
			} catch (error) {
				let directHandler = "not attempted";
				if (process.platform === "linux") {
					try {
						run(resolve(state, "private/browser.sh"), [url]);
						directHandler = "passed";
					} catch (diagnostic) {
						directHandler = String(diagnostic);
					}
				}
				writeFileSync(
					resolve(evidence, "browser-handler.json"),
					JSON.stringify({ error: String(error), directHandler }, null, 2),
				);
				throw error;
			}
			const page = await until(
				"OS HTTPS handler in controlled browser profile",
				() => {
					const page = context.pages().find((page) => page.url() === url);
					if (!page)
						writeFileSync(
							resolve(evidence, "browser-handler-pages.json"),
							JSON.stringify(context.pages().map((page) => page.url())),
						);
					return page;
				},
			);
			await page.waitForFunction(() => {
				try {
					return (
						JSON.parse(document.querySelector("pre")?.textContent ?? "").ok ===
						true
					);
				} catch {
					return false;
				}
			});
			await page.screenshot({ path: resolve(evidence, "browser-handler.png") });
			await page.close();
		},
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
