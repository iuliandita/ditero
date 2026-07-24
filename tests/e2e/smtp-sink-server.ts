// Standalone SMTP sink for the mail-path e2e, wired into playwright.config the
// way ntfy-stub.ts is. Two differences from the ntfy stub, both forced by what
// mail is:
//   - It binds LOOPBACK. The ntfy stub cannot (safe-http refuses 127.0.0.0/8
//     unconditionally), but the mail transport speaks node:net SMTP and never
//     goes through safeFetch, so there is no SSRF boundary to satisfy and the
//     loopback bind is both correct and the least reachable option.
//   - It speaks the real SMTP protocol on the wire (tests/support/smtp-sink.ts),
//     so the assertions read the actual command lines and DATA bytes rather than
//     a captured object -- the M3a lesson that a mailer which threw on every real
//     send stayed invisible while every test injected a double.
//
// GET /_captured (on the HTTP port) replays what the sink received so the spec,
// in a separate process, can assert on the wire. The app server (server B in
// playwright.config) points DITERO_SMTP_HOST/PORT at the SMTP port below.
import { startSmtpSink } from "../support/smtp-sink.ts";

const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 4600);
const HTTP_PORT = Number(process.env.E2E_SMTP_HTTP_PORT ?? 4601);

const sink = await startSmtpSink({ port: SMTP_PORT });

Bun.serve({
	port: HTTP_PORT,
	fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/health") return new Response("ok");
		if (pathname === "/_captured") {
			return Response.json({
				commands: sink.commands,
				messages: sink.messages,
			});
		}
		return new Response(null, { status: 404 });
	},
});

console.log(`smtp sink on :${SMTP_PORT}, capture on :${HTTP_PORT}`);
