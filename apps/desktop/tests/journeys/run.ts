import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { systemBrowser } from "./browser.ts";
import { desktop } from "./driver.ts";
import {
	background,
	evidence,
	root,
	run,
	stack,
	stage,
	state,
	stopChildren,
	until,
	untrustedFixture,
} from "./stack.ts";

type Result = {
	journey: string;
	status: "passed" | "failed" | "unqualified on hosted runner" | "not-run";
	detail?: string;
};
const expectedJourneys = [
	"installed first launch",
	"untrusted HTTPS certificate is refused",
	"trusted HTTPS and system-browser consent",
	"desktop task reaches server",
	"server task reaches desktop",
	"offline change remains queued",
	"offline cold start with verified evidence",
	"reconnect drains durable change",
	"OS notification permission and interaction",
	"server switch isolates account and cache",
	"sign-out clears selected OS-keystore credential",
	"sign-out clears final OS-keystore credential",
];
const hostedWindows =
	process.platform === "win32" &&
	process.env.GITHUB_ACTIONS === "true" &&
	process.env.RUNNER_ENVIRONMENT === "github-hosted";
const results: Result[] = [];
const ids = (id: string) => `[data-testid="${id}"]`;
let app: Awaited<ReturnType<typeof desktop>> | undefined;
let servers: Awaited<ReturnType<typeof stack>> | undefined;
let browser: Awaited<ReturnType<typeof systemBrowser>> | undefined;
function record(result: Result) {
	results.push(result);
	console.log(
		`${result.status}: ${result.journey}${result.detail ? `: ${result.detail}` : ""}`,
	);
	writeFileSync(
		resolve(evidence, "results.json"),
		JSON.stringify(
			{
				runner: process.env.RUNNER_OS,
				architecture: process.arch,
				sha: process.env.GITHUB_SHA,
				results,
			},
			null,
			2,
		),
	);
}
async function journey(
	name: string,
	action: () => Promise<
		| undefined
		| string
		| { status: "unqualified on hosted runner"; detail: string }
	>,
) {
	try {
		const detail = await action();
		record({
			journey: name,
			status: typeof detail === "object" ? detail.status : "passed",
			...(typeof detail === "string"
				? { detail }
				: typeof detail === "object"
					? { detail: detail.detail }
					: {}),
		});
	} catch (error) {
		record({ journey: name, status: "failed", detail: String(error) });
		await app
			?.screenshot(`failure-${results.length}`)
			.catch((diagnostic) => console.error(`Screenshot failed: ${diagnostic}`));
		throw error;
	}
}
let installedApplication = "";
function vault() {
	const raw =
		process.platform === "darwin"
			? run(installedApplication, ["--journey-keystore"], {
					...process.env,
					DITERO_JOURNEY_DIRECTORY: state,
					DITERO_JOURNEY_TOKEN: randomBytes(32).toString("hex"),
				})
			: run("python3", [resolve(root, "apps/desktop/tests/journeys/vault.py")]);
	return JSON.parse(raw) as {
		sessionCount: number;
		credentialCount: number;
		evidenceCount: number;
		pending: boolean;
		evidenceReady: boolean;
	};
}
function notificationSnapshot(name: string) {
	const raw =
		process.platform === "darwin"
			? run(installedApplication, ["--journey-notifications"], {
					...process.env,
					DITERO_JOURNEY_DIRECTORY: state,
					DITERO_JOURNEY_TOKEN: randomBytes(32).toString("hex"),
				})
			: process.platform === "win32"
				? run("powershell", [
						"-NoProfile",
						"-File",
						resolve(
							root,
							"apps/desktop/tests/journeys/windows-notification-count.ps1",
						),
					])
				: JSON.stringify({
						reader: "dunst-session",
						deliveredCount:
							Number(run("dunstctl", ["count", "displayed"])) +
							Number(run("dunstctl", ["count", "waiting"])),
						pendingCount: 0,
					});
	const snapshot = JSON.parse(raw) as {
		deliveredCount: number;
		pendingCount: number;
	};
	assert(
		Number.isSafeInteger(snapshot.deliveredCount) &&
			snapshot.deliveredCount >= 0,
	);
	assert(
		Number.isSafeInteger(snapshot.pendingCount) && snapshot.pendingCount >= 0,
	);
	writeFileSync(resolve(evidence, `${name}.json`), JSON.stringify(snapshot));
	return snapshot.deliveredCount + snapshot.pendingCount;
}
try {
	const installed = JSON.parse(
		readFileSync(resolve(state, "installed.json"), "utf8"),
	) as { application: string };
	installedApplication = installed.application;
	await journey("installed first launch", async () => {
		stage("launching installed desktop application");
		app = await desktop(installed.application);
		await until("server selector", () =>
			app?.evaluate("!!document.querySelector('#native-server')"),
		);
		await app.screenshot("first-launch");
	});
	assert(app);
	const native = app;
	let desktopTaskId = "";
	await journey("untrusted HTTPS certificate is refused", async () => {
		const rejected = await untrustedFixture();
		try {
			await native.fill("#native-server", rejected.origin);
			await native.click('button[type="submit"]');
			await until("certificate refusal", () =>
				native.evaluate("!!document.querySelector('[role=alert]')"),
			);
			assert.equal(
				rejected.requests(),
				0,
				"Untrusted TLS must fail before HTTP",
			);
			assert.equal(
				await native.evaluate(
					"globalThis.__journeyProtocol.filter(e=>e.direction==='reply' && e.op==='grant').at(-1)?.code",
				),
				"transport-refused",
				"The negative control must reach the native TLS request",
			);
			await native.screenshot("untrusted-certificate-refused");
		} finally {
			await rejected.close();
		}
	});
	stage("starting PostgreSQL, Bun and Zero");
	servers = await stack();
	stage("starting and configuring the system browser");
	browser = await systemBrowser();
	const [a, b] = servers.instances;
	assert(a && b);
	stage("checking the OS HTTPS handler");
	await browser.probe(a.api.origin);
	stage("creating fixture accounts");
	const password = `Journey-${randomBytes(16).toString("hex")}`;
	const email = "journey@example.test";
	for (const instance of [a, b]) {
		const response = await browser.request.post(
			`${instance.api.origin}/api/auth/sign-up/email`,
			{
				headers: { Origin: instance.api.origin },
				data: { name: "Journey User", email, password },
			},
		);
		assert.equal(response.status(), 200, await response.text());
		const user = await instance.pool.query(
			'select id from "user" where email=$1',
			[email],
		);
		assert.equal(user.rowCount, 1);
		const workspace = await instance.pool.query(
			"select id from workspace where owner_id=$1 and kind='personal'",
			[user.rows[0].id],
		);
		assert.equal(workspace.rowCount, 1);
		await instance.pool.query(
			"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,$4,'a0')",
			[
				`list_${instance.name}`,
				workspace.rows[0].id,
				user.rows[0].id,
				`List ${instance.name}`,
			],
		);
	}
	await browser.context.clearCookies();
	async function signIn(origin: string, selected?: () => Promise<void>) {
		await native.fill("#native-server", origin);
		await native.click('button[type="submit"]');
		await selected?.();
		await browser?.consent(origin, email, password);
		await until("finish sign-in control", () =>
			native.evaluate(
				`Array.from(document.querySelectorAll('button')).some(e=>e.textContent==='Finish signing in')`,
			),
		);
		await native.evaluate(
			`(() => { Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Finish signing in').click(); return true })()`,
		);
		await until(
			"signed-in workspace",
			() =>
				native.evaluate(
					`!!document.querySelector(${JSON.stringify(ids("workspace"))})`,
				),
			90,
		);
	}
	async function openList(name: string) {
		await until(`synced list ${name}`, () =>
			native.evaluate(
				`Array.from(document.querySelectorAll('button')).some(e=>e.textContent.includes(${JSON.stringify(name)}))`,
			),
		);
		await native.evaluate(
			`(() => { Array.from(document.querySelectorAll('button')).find(e=>e.textContent.includes(${JSON.stringify(name)})).click(); return true })()`,
		);
		await until("list input", () =>
			native.evaluate(
				`!!document.querySelector(${JSON.stringify(ids("new-task"))})`,
			),
		);
	}
	async function addTask(title: string) {
		await native.fill(ids("new-task"), title);
		await native.click(ids("new-task-submit"));
		await until(`visible task ${title}`, () =>
			native.evaluate(
				`document.querySelector('[data-testid="list"]').textContent.includes(${JSON.stringify(title)})`,
			),
		);
	}
	await journey("trusted HTTPS and system-browser consent", async () => {
		await signIn(a.api.origin);
		const protectedState = await until(
			"complete verified OS-store evidence",
			() => {
				const proof = vault();
				return proof.evidenceReady ? proof : undefined;
			},
		);
		assert.equal(protectedState.sessionCount, 1);
		assert.equal(protectedState.credentialCount, 1);
		assert.equal(protectedState.evidenceCount, 1);
		writeFileSync(
			resolve(evidence, "vault-online.json"),
			JSON.stringify(protectedState),
		);
		await native.screenshot("signed-in");
	});
	await journey("desktop task reaches server", async () => {
		await openList("List journey_a");
		await addTask("Created on desktop");
		await until(
			"server mutation witness",
			async () =>
				(
					await a.pool.query(
						"select id from task where list_id='list_journey_a' and title='Created on desktop'",
					)
				).rowCount === 1,
		);
		desktopTaskId = (
			await a.pool.query(
				"select id from task where list_id='list_journey_a' and title='Created on desktop'",
			)
		).rows[0].id;
	});
	await journey("server task reaches desktop", async () => {
		await a.pool.query(
			"insert into task(id,list_id,title,sort_key) values('task_server','list_journey_a','Created on server','a1')",
		);
		await until("server-to-desktop sync", () =>
			native.evaluate(
				"document.querySelector('[data-testid=\"list\"]').textContent.includes('Created on server')",
			),
		);
		await native.screenshot("bidirectional-sync");
	});
	await journey("offline change remains queued", async () => {
		await a.api.offline();
		await a.zero.offline();
		await native.click(`[data-task-id="${desktopTaskId}"]`);
		await native.fill(ids("task-detail-title"), "Edited while offline");
		await native.evaluate(
			"(() => { document.querySelector('[data-testid=\"task-detail-title\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true })()",
		);
		await native.click(ids("task-detail-close"));
		await until("optimistic offline edit", () =>
			native.evaluate(
				"document.querySelector('[data-testid=\"list\"]').textContent.includes('Edited while offline')",
			),
		);
		assert.equal(
			(
				await a.pool.query("select title from task where id=$1", [
					desktopTaskId,
				])
			).rows[0].title,
			"Created on desktop",
		);
		await addTask("Queued while offline");
		assert.equal(
			(
				await a.pool.query(
					"select id from task where title='Queued while offline'",
				)
			).rowCount,
			0,
		);
		await native.screenshot("offline-change");
	});
	await journey("offline cold start with verified evidence", async () => {
		writeFileSync(
			resolve(evidence, "vault-before-close.json"),
			JSON.stringify(vault()),
		);
		await native.close();
		writeFileSync(
			resolve(evidence, "vault-after-close.json"),
			JSON.stringify(vault()),
		);
		const network = (name: string) => {
			if (process.platform === "win32")
				run("pwsh", [
					"-NoProfile",
					"-File",
					resolve(root, "apps/desktop/tests/journeys/network.ps1"),
					"-Port",
					new URL(a.api.origin).port,
					"-Name",
					name,
				]);
		};
		network("before-cold-launch");
		await native.launch();
		network("after-cold-launch");
		await until("offline workspace", () =>
			native.evaluate(
				`!!document.querySelector(${JSON.stringify(ids("workspace"))})`,
			),
		);
		await openList("List journey_a");
		await until("durable offline task", () =>
			native.evaluate(
				"document.querySelector('[data-testid=\"list\"]').textContent.includes('Queued while offline') && document.querySelector('[data-testid=\"list\"]').textContent.includes('Edited while offline')",
			),
		);
		assert.equal(
			(
				await a.pool.query(
					"select id from task where title='Queued while offline'",
				)
			).rowCount,
			0,
		);
		await native.screenshot("offline-cold-start");
	});
	await journey("reconnect drains durable change", async () => {
		await a.api.online();
		await a.zero.online();
		await until(
			"queued task committed",
			async () =>
				(
					await a.pool.query(
						"select id from task where title='Queued while offline'",
					)
				).rowCount === 1,
			120,
		);
		await until(
			"offline edit committed",
			async () =>
				(
					await a.pool.query("select title from task where id=$1", [
						desktopTaskId,
					])
				).rows[0].title === "Edited while offline",
		);
	});
	await native.click(ids("nav-settings"));
	await until("desktop notification status", () =>
		native.evaluate("!!document.querySelector('#native-push-heading')"),
	);
	let pendingNotification = false;
	await journey("OS notification permission and interaction", async () => {
		if (hostedWindows) {
			assert.equal(process.env.GITHUB_ACTIONS, "true");
			assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
			const session = JSON.parse(
				readFileSync(resolve(evidence, "session-privileges.json"), "utf8"),
			) as { elevated: boolean; administrator: boolean; method: string };
			assert.equal(typeof session.elevated, "boolean");
			assert.equal(typeof session.administrator, "boolean");
			assert.equal(session.method, "inherited-runner-token");
			const qualification = {
				status: "unqualified on hosted runner" as const,
				showClick: "not-qualified",
				retirement: "not-qualified",
				session,
				reason:
					"No banner or click was observed on the hosted Windows runner, including with Do not disturb off; elevation as the cause remains unproven. See #346.",
			};
			writeFileSync(
				resolve(evidence, "notification-qualification.json"),
				JSON.stringify(qualification, null, 2),
			);
			return { status: qualification.status, detail: qualification.reason };
		}
		await until("enable notifications", () =>
			native.evaluate(
				"Array.from(document.querySelectorAll('button')).some(e=>e.textContent==='Enable desktop notifications')",
			),
		);
		const consent =
			process.platform === "darwin"
				? background(
						"notification-consent",
						resolve(state, "..", "journey-notifications"),
						["permission"],
					)
				: undefined;
		if (consent)
			await until("notification permission foreground", () => {
				const focus = JSON.parse(
					readFileSync(
						resolve(evidence, "notification-permission-focus.json"),
						"utf8",
					),
				) as { frontmost: string };
				return focus.frontmost === "io.ditero.desktop";
			});
		await native.evaluate(
			"(() => { Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Enable desktop notifications').click(); return true })()",
		);
		const permission = await until(
			"desktop registration or macOS denial",
			async () => {
				const registration = (
					await a.pool.query(
						"select id,user_id from native_push_registration where provider='desktop'",
					)
				).rows[0] as { id: string; user_id: string } | undefined;
				if (registration) return { registration };
				if (
					process.platform === "darwin" &&
					(await native.evaluate(
						"document.body.textContent.includes('Desktop notification permission is denied. Allow notifications in your system settings, then try again.')",
					))
				)
					return { denied: true };
				return undefined;
			},
		);
		if (consent?.exitCode === null) consent.kill();
		if ("denied" in permission) {
			assert.equal(process.platform, "darwin");
			assert.equal(notificationSnapshot("notification-permission-denied"), 0);
			const snapshot = JSON.parse(
				readFileSync(
					resolve(evidence, "notification-permission-denied.json"),
					"utf8",
				),
			) as { authorizationStatus: number };
			assert.equal(snapshot.authorizationStatus, 1);
			assert.match(
				readFileSync(resolve(evidence, "installed-signature.txt"), "utf8"),
				/Signature=adhoc/,
			);
			const focus = JSON.parse(
				readFileSync(
					resolve(evidence, "notification-permission-focus.json"),
					"utf8",
				),
			) as { frontmost: string };
			assert.equal(focus.frontmost, "io.ditero.desktop");
			assert.equal(
				(
					await a.pool.query(
						"select count(*)::int as count from native_push_registration where provider='desktop'",
					)
				).rows[0].count,
				0,
			);
			writeFileSync(
				resolve(evidence, "notification-qualification.json"),
				JSON.stringify({
					permission: "denied",
					reader: "fresh-os-notification-center",
					signature: "adhoc",
					showClick: "not-qualified",
					reason:
						"Hosted macOS denies authorization for this installed ad-hoc bundle; no permission bypass or credential registration",
				}),
			);
			await native.screenshot("notification-permission-denied");
			return "OS denial and localized refusal verified; ad-hoc hosted display/click remain unqualified";
		}
		const { registration } = permission;
		assert(registration);
		await a.pool.query(
			"insert into notification_outbox(id,recipient_user_id,channel_kind,native_registration_id,payload,idempotency_key,status) values('journey_notification',$1,'nativepush',$2,$3,'journey_notification','sent')",
			[
				registration.user_id,
				registration.id,
				JSON.stringify({ taskId: "task_server" }),
			],
		);
		await a.pool.query(
			"insert into native_desktop_mailbox(notification_id,registration_id,user_id,expires_at) values('journey_notification',$1,$2,clock_timestamp()+interval '5 minutes')",
			[registration.id, registration.user_id],
		);
		if (process.platform === "linux") {
			await until(
				"OS popup",
				() => Number(run("dunstctl", ["count", "displayed"])) === 1,
				45,
			);
			run("scrot", [resolve(evidence, "notification-shown.png")]);
			const window = run("xdotool", ["search", "--class", "Dunst"]).split(
				"\n",
			)[0];
			assert(window);
			run("xdotool", [
				"mousemove",
				"--sync",
				"--window",
				window,
				"180",
				"40",
				"click",
				"1",
			]);
		} else {
			// The fixture's HTTPS loop must keep serving polls while the OS helper waits.
			const click =
				process.platform === "win32"
					? background("notification-click", "pwsh", [
							"-NoProfile",
							"-File",
							resolve(
								root,
								"apps/desktop/tests/journeys/windows-notifications.ps1",
							),
						])
					: background(
							"notification-click",
							resolve(state, "..", "journey-notifications"),
							["click"],
						);
			await until(
				"OS notification helper completion",
				() => click.exitCode !== null,
				60,
			);
			assert.equal(
				click.exitCode,
				0,
				readFileSync(resolve(evidence, "notification-click.log"), "utf8"),
			);
		}

		await until("notification task destination", () =>
			native.evaluate(
				"document.querySelector('[data-testid=\"task-detail-title\"]')?.value==='Created on server'",
			),
		);
		await until(
			"durable notification receipt",
			async () =>
				(
					await a.pool.query(
						"select received_at from native_desktop_mailbox where notification_id='journey_notification'",
					)
				).rows[0]?.received_at,
		);
		assert.equal(
			(await a.pool.query("select done from task where id='task_server'"))
				.rows[0].done,
			false,
		);
		await native.screenshot("notification-clicked");
		await native.click(ids("task-detail-close"));
		await native.click(ids("nav-settings"));
		await until(
			"clicked notification removed from OS",
			() => notificationSnapshot("notification-after-click") === 0,
		);
		await a.pool.query(
			"insert into notification_outbox(id,recipient_user_id,channel_kind,native_registration_id,payload,idempotency_key,status) values('journey_retired',$1,'nativepush',$2,$3,'journey_retired','sent')",
			[
				registration.user_id,
				registration.id,
				JSON.stringify({ taskId: "task_server" }),
			],
		);
		await a.pool.query(
			"insert into native_desktop_mailbox(notification_id,registration_id,user_id,expires_at) values('journey_retired',$1,$2,clock_timestamp()+interval '5 minutes')",
			[registration.id, registration.user_id],
		);
		await until(
			"pending OS notification positive control",
			() => notificationSnapshot("notification-before-switch") === 1,
			45,
		);
		pendingNotification = true;
		writeFileSync(
			resolve(evidence, "notification-qualification.json"),
			JSON.stringify({
				permission: "granted",
				showClick: "verified",
				retirement: "positive controls required",
			}),
		);
	}).catch((error) =>
		console.error(`Notification qualification failed: ${error}`),
	);

	await journey("server switch isolates account and cache", async () => {
		await native.evaluate(
			"(() => { Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Change server').click(); return true })()",
		);
		await signIn(b.api.origin, async () => {
			if (pendingNotification)
				await until(
					"server switch withdraws previous account notification",
					() => notificationSnapshot("notification-after-switch") === 0,
					5,
				);
		});
		await openList("List journey_b");
		assert.equal(
			await native.evaluate(
				"document.body.textContent.includes('Created on desktop') || document.body.textContent.includes('Edited while offline') || document.body.textContent.includes('Queued while offline') || document.body.textContent.includes('List journey_a')",
			),
			false,
		);
		await addTask("Only on server B");
		await until(
			"server B mutation",
			async () =>
				(
					await b.pool.query(
						"select id from task where title='Only on server B'",
					)
				).rowCount === 1,
		);
		assert.equal(
			(await a.pool.query("select id from task where title='Only on server B'"))
				.rowCount,
			0,
		);
		await until(
			"both scoped OS-store credentials",
			() => vault().sessionCount === 2,
		);
		await native.screenshot("server-isolation");
	});
	await journey("sign-out clears selected OS-keystore credential", async () => {
		await native.click(ids("nav-settings"));
		await native.click(ids("sign-out"));
		await until("signed-out selector", () =>
			native.evaluate("!!document.querySelector('#native-server')"),
		);
		await until("selected credential removed from OS store", () => {
			const proof = vault();
			return (
				!proof.pending &&
				proof.sessionCount === 1 &&
				proof.credentialCount === 1
			);
		});
		await native.close();
		await native.launch();
		await until("cold signed-out selector", () =>
			native.evaluate("!!document.querySelector('#native-server')"),
		);
		assert.equal(
			await native.evaluate(
				"document.body.textContent.includes('Only on server B')",
			),
			false,
		);
		await native.screenshot("signed-out-cold-start");
		writeFileSync(
			resolve(evidence, "vault-sign-out.json"),
			JSON.stringify(vault()),
		);
	});
	await journey("sign-out clears final OS-keystore credential", async () => {
		await native.fill("#native-server", a.api.origin);
		await native.click('button[type="submit"]');
		await until("retained account restore", () =>
			native.evaluate(
				`!!document.querySelector(${JSON.stringify(ids("workspace"))})`,
			),
		);
		await native.click(ids("nav-settings"));
		if (pendingNotification) {
			const registration = (
				await a.pool.query(
					"select id,user_id from native_push_registration where provider='desktop'",
				)
			).rows[0] as { id: string; user_id: string };
			assert(registration);
			await a.pool.query(
				"insert into notification_outbox(id,recipient_user_id,channel_kind,native_registration_id,payload,idempotency_key,status) values('journey_signed_out',$1,'nativepush',$2,$3,'journey_signed_out','sent')",
				[
					registration.user_id,
					registration.id,
					JSON.stringify({ taskId: "task_server" }),
				],
			);
			await a.pool.query(
				"insert into native_desktop_mailbox(notification_id,registration_id,user_id,expires_at) values('journey_signed_out',$1,$2,clock_timestamp()+interval '5 minutes')",
				[registration.id, registration.user_id],
			);
			await until(
				"sign-out OS notification positive control",
				() => notificationSnapshot("notification-before-sign-out") === 1,
				45,
			);
		}
		await native.click(ids("sign-out"));
		if (pendingNotification)
			await until(
				"sign-out withdraws captured account notification",
				() => notificationSnapshot("notification-after-sign-out") === 0,
				5,
			);
		await until("all credentials removed", () => {
			const proof = vault();
			writeFileSync(
				resolve(evidence, "vault-empty-pending.json"),
				JSON.stringify(proof),
			);
			return (
				!proof.pending &&
				proof.sessionCount === 0 &&
				proof.credentialCount === 0 &&
				proof.evidenceCount === 0
			);
		});
		writeFileSync(
			resolve(evidence, "vault-empty.json"),
			JSON.stringify(vault()),
		);
		await native.close();
		await native.launch();
		await until("cold empty-account selector", () =>
			native.evaluate("!!document.querySelector('#native-server')"),
		);
		await native.screenshot("empty-vault-cold-start");
	});
	const unqualified = results.filter(
		(result) => result.status === "unqualified on hosted runner",
	);
	assert.deepEqual(
		unqualified.map((result) => result.journey),
		hostedWindows ? ["OS notification permission and interaction"] : [],
	);
	assert.equal(results.length, expectedJourneys.length);
	assert.equal(
		results.filter((result) => result.status === "passed").length,
		hostedWindows ? 11 : 12,
	);
} catch (error) {
	console.error(error);
	try {
		writeFileSync(
			resolve(evidence, "vault-failure.json"),
			JSON.stringify(vault()),
		);
	} catch (diagnostic) {
		console.error(`Failure vault diagnostic: ${diagnostic}`);
	}
	if (process.platform === "darwin") {
		try {
			run("screencapture", ["-x", resolve(evidence, "failure-desktop.png")]);
		} catch (diagnostic) {
			console.error(`OS screenshot failed: ${diagnostic}`);
		}
	}
	if (process.platform === "win32") {
		try {
			run("pwsh", [
				"-NoProfile",
				"-File",
				resolve(root, "apps/desktop/tests/journeys/capture.ps1"),
			]);
		} catch (diagnostic) {
			console.error(`OS screenshot failed: ${diagnostic}`);
		}
	}
	writeFileSync(
		resolve(evidence, "failure.json"),
		JSON.stringify({ error: String(error) }, null, 2),
	);
	process.exitCode = 1;
} finally {
	for (const name of expectedJourneys) {
		if (!results.some((result) => result.journey === name))
			record({
				journey: name,
				status: "not-run",
				detail: "An earlier prerequisite failed",
			});
	}
	await app?.stop();
	await browser?.close();
	await servers?.close();
	stopChildren();
	const summary = results
		.map(
			(result) =>
				`| ${result.journey} | ${result.status} | ${result.detail ?? ""} |`,
		)
		.join("\n");
	writeFileSync(
		resolve(evidence, "summary.md"),
		`| Journey | Result | Detail |\n| --- | --- | --- |\n${summary}\n`,
	);
}
