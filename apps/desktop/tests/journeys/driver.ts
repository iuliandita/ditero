import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import {
	background,
	evidence,
	freePort,
	root,
	run,
	stage,
	state,
	until,
} from "./stack.ts";

export async function desktop(application: string) {
	let session = "";
	let port = 0;
	let app: ReturnType<typeof background> | undefined;
	const token = randomBytes(32).toString("hex");
	async function request(method: string, path: string, body?: unknown) {
		const response = await fetch(`http://127.0.0.1:${port}${path}`, {
			method,
			signal: AbortSignal.timeout(60000),
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const data = (await response.json()) as { value: unknown };
		if (!response.ok)
			throw new Error(`WebDriver ${method} ${path}: ${JSON.stringify(data)}`);
		return data.value;
	}
	let driver: ReturnType<typeof background> | undefined;
	async function launch() {
		stage("starting installed desktop process");
		if (process.platform === "darwin") {
			const ready = resolve(state, "hook.json");
			if (existsSync(ready)) unlinkSync(ready);
			app = background("desktop", application, [], {
				...process.env,
				DITERO_JOURNEY_DIRECTORY: state,
				DITERO_JOURNEY_TOKEN: token,
			});
			port = await until("macOS debug hook", () =>
				existsSync(ready)
					? (JSON.parse(readFileSync(ready, "utf8")).port as number)
					: undefined,
			);
		} else {
			if (!driver) {
				port = await freePort();
				const nativePort = await freePort();
				const args = [
					"--port",
					String(port),
					"--native-port",
					String(nativePort),
				];
				if (process.env.JOURNEY_NATIVE_DRIVER)
					args.push("--native-driver", process.env.JOURNEY_NATIVE_DRIVER);
				driver = background("tauri-driver", "tauri-driver", args);
				await until(
					"tauri-driver",
					async () => (await fetch(`http://127.0.0.1:${port}/status`)).ok,
				);
			}
			let capabilities: Record<string, unknown> = {
				"tauri:options": { application },
			};
			if (process.platform === "win32") {
				const debugPort = await freePort();
				run("pwsh", [
					"-NoProfile",
					"-File",
					resolve(root, "apps/desktop/tests/journeys/windows-webview.ps1"),
					"-Port",
					String(debugPort),
					"-Profile",
					resolve(state, "webview-profile"),
				]);
				app = background("desktop", application, [], {
					...process.env,
					WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --disable-gpu`,
					WEBVIEW2_USER_DATA_FOLDER: resolve(state, "webview-profile"),
				});
				stage("waiting for installed WebView2 debug endpoint");
				await until("installed WebView2 debug endpoint", async () => {
					if (app?.exitCode !== null)
						throw new Error(`Desktop exited ${app?.exitCode}`);
					return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok;
				});
				capabilities = {
					browserName: "webview2",
					"ms:edgeOptions": { debuggerAddress: `127.0.0.1:${debugPort}` },
				};
			}
			stage("creating native WebDriver session");
			const value = (await request("POST", "/session", {
				capabilities: {
					alwaysMatch: capabilities,
				},
			})) as { sessionId: string };
			session = value.sessionId;
		}
		await until("native transport", () =>
			evaluate("!!globalThis.NativeDitero"),
		);
		await evaluate(`(() => {
		const native = globalThis.NativeDitero, original = native.postMessage;
		const operations = new Map(), trace = globalThis.__journeyProtocol = [];
		let listener = native.onmessage;
		const record = value => { trace.push(value); if (trace.length > 200) trace.shift(); };
		native.postMessage = function(bytes) {
			const message = JSON.parse(bytes);
			operations.set(message.rid, message.op);
			record({direction:'request', op:message.op, rid:message.rid});
			return original.call(native, bytes);
		};
		Object.defineProperty(native, 'onmessage', {
			get: () => event => {
				const message = JSON.parse(event.data);
				if (message.t === 'reply') record({direction:'reply', op:operations.get(message.rid), rid:message.rid, ok:message.ok, code:message.code});
				listener?.call(native, event);
			},
			set: value => { listener = value; }
		});
		return true;
	})()`);
	}
	async function evaluate<T = unknown>(script: string): Promise<T> {
		if (process.platform !== "darwin")
			return (await request("POST", `/session/${session}/execute/sync`, {
				script: `return (${script});`,
				args: [],
			})) as T;
		return await new Promise<T>((done, fail) => {
			const socket = connect(port, "127.0.0.1");
			let bytes = "";
			socket.setTimeout(15000, () =>
				socket.destroy(new Error("debug hook response timeout")),
			);
			socket.on("connect", () =>
				socket.write(
					`${JSON.stringify({ token, script: script === "__journey_close__" ? script : `JSON.stringify((${script}))` })}\n`,
				),
			);
			socket.on("error", fail);
			socket.on("end", () => {
				if (!bytes.includes("\n"))
					fail(new Error("Debug hook closed without a response"));
			});
			socket.on("data", (chunk) => {
				bytes += chunk.toString();
				if (bytes.includes("\n")) {
					socket.end();
					try {
						let value = JSON.parse(bytes.trim());
						if (typeof value === "string") value = JSON.parse(value);
						done(value as T);
					} catch (error) {
						fail(error);
					}
				}
			});
		});
	}
	async function screenshot(name: string) {
		writeFileSync(
			resolve(evidence, `${name}-protocol.json`),
			JSON.stringify(
				await evaluate("globalThis.__journeyProtocol ?? []"),
				null,
				2,
			),
		);
		writeFileSync(
			resolve(evidence, `${name}.html`),
			await evaluate<string>("document.documentElement.outerHTML"),
		);
		if (process.platform === "darwin")
			run("screencapture", ["-x", resolve(evidence, `${name}.png`)]);
		else
			writeFileSync(
				resolve(evidence, `${name}.png`),
				Buffer.from(
					(await request("GET", `/session/${session}/screenshot`)) as string,
					"base64",
				),
			);
	}
	async function click(selector: string) {
		await until(`visible ${selector}`, () =>
			evaluate(
				`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !!e && e.getBoundingClientRect().width > 0 && !e.disabled })()`,
			),
		);
		if (process.platform !== "darwin") {
			const element = (await request("POST", `/session/${session}/element`, {
				using: "css selector",
				value: selector,
			})) as Record<string, string>;
			await request(
				"POST",
				`/session/${session}/element/${element["element-6066-11e4-a52e-4f735466cecf"]}/click`,
				{},
			);
		} else
			await evaluate(
				`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,button:0,pointerType:'mouse'})); e.dispatchEvent(new PointerEvent('pointerup', {bubbles:true,button:0,pointerType:'mouse'})); e.click(); return true })()`,
			);
	}
	async function fill(selector: string, value: string) {
		await until(`input ${selector}`, () =>
			evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),
		);
		await evaluate(
			`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const setter = Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set; setter.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return true })()`,
		);
	}
	async function close() {
		if (process.platform === "darwin") {
			await evaluate("__journey_close__");
			await until("graceful desktop close", () => app?.exitCode !== null, 30);
		} else {
			if (process.platform === "win32") {
				run("pwsh", [
					"-NoProfile",
					"-File",
					resolve(root, "apps/desktop/tests/journeys/close.ps1"),
					"-Application",
					application,
				]);
			} else {
				const pid = Number(run("pgrep", ["-x", "ditero-desktop"]));
				if (!Number.isSafeInteger(pid) || pid <= 0)
					throw new Error("Expected one desktop PID");
				const windows = run("wmctrl", ["-lp"])
					.split("\n")
					.map((line) => line.trim().split(/\s+/))
					.filter((fields) => Number(fields[2]) === pid);
				assert.equal(
					windows.length,
					1,
					"Expected one window owned by the installed desktop process",
				);
				run("wmctrl", ["-ic", windows[0][0]]);
				await until(
					"managed desktop exit",
					() => {
						const status = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
							encoding: "utf8",
						});
						// An exited child may await reaping by WebKitWebDriver.
						return status.status === 1 || status.stdout.trim().startsWith("Z");
					},
					30,
				);
			}
			await request("DELETE", `/session/${session}`).catch(() => {});
		}
	}
	await launch();
	if (process.platform === "darwin") {
		const refused = await new Promise<string>((done, fail) => {
			const socket = connect(port, "127.0.0.1");
			let response = "";
			socket.setTimeout(6000, () =>
				socket.destroy(new Error("Unauthenticated hook did not close")),
			);
			socket.on("error", fail);
			socket.on("data", (chunk) => {
				response += chunk.toString();
			});
			socket.on("end", () => done(response));
			socket.on("connect", () =>
				socket.end(
					`${JSON.stringify({ token: "0".repeat(64), script: "globalThis.__unauthorizedJourney=true" })}\n`,
				),
			);
		});
		assert.equal(
			refused,
			"",
			"Unauthenticated evaluation must have no response",
		);
		assert.equal(
			await evaluate("'__unauthorizedJourney' in globalThis"),
			false,
		);
		writeFileSync(
			resolve(evidence, "hook-authentication.json"),
			JSON.stringify({ unauthenticatedEvaluationRefused: true }),
		);
	}
	return {
		evaluate,
		screenshot,
		click,
		fill,
		launch,
		close,
		async stop() {
			if (app?.exitCode === null) app.kill();
			if (session)
				await request("DELETE", `/session/${session}`).catch((error) =>
					console.error(`WebDriver cleanup: ${error}`),
				);
			driver?.kill();
		},
	};
}
