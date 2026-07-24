import { afterEach, describe, expect, it } from "vitest";
import type { SmtpSink } from "../../../../tests/support/smtp-sink.ts";
import { startSmtpSink } from "../../../../tests/support/smtp-sink.ts";
import {
	channelErrorCode,
	classifyRetry,
} from "../../../domain/notification-retry.ts";
import type {
	Mailer,
	MailMessage,
	MailResult,
	SendOptions,
} from "../../mail/transport.ts";
import { createMailer } from "../../mail/transport.ts";
import { emailAdapter } from "./email.ts";
import type { AdapterContext, ChannelPayload } from "./types.ts";

const config = { address: "recipient@example.test" };

const payload: ChannelPayload = {
	title: "Walk the dog",
	body: "Due 2026-08-01T09:00:00.000Z",
	urgent: false,
	ackUrl: "https://app.example.test/api/notifications/ack/abc123",
};

function context(
	mailer: Mailer | null,
	overrides: Partial<AdapterContext> = {},
): AdapterContext {
	return {
		allowedPrivateCIDRs: [],
		deadlineMs: 5_000,
		signal: new AbortController().signal,
		mailer,
		...overrides,
	};
}

function recorder(result: MailResult = { ok: true }) {
	const sent: { message: MailMessage; options?: SendOptions }[] = [];
	const mailer: Mailer = {
		from: "ditero@example.test",
		async send(message, options) {
			sent.push({ message, options });
			return result;
		},
	};
	return { sent, mailer };
}

const sinks: SmtpSink[] = [];
afterEach(async () => {
	await Promise.all(sinks.splice(0).map((sink) => sink.close()));
});

describe("emailAdapter", () => {
	it("sends the title as the subject and the ack capability as a link", async () => {
		const { sent, mailer } = recorder();
		const result = await emailAdapter.send(config, payload, context(mailer));

		expect(result).toMatchObject({ ok: true });
		expect(sent).toHaveLength(1);
		expect(sent[0].message).toMatchObject({
			to: "recipient@example.test",
			subject: "Walk the dog",
		});
		expect(sent[0].message.text).toContain(payload.ackUrl);
		expect(sent[0].options?.deadlineMs).toBe(5_000);
	});

	it("omits the ack line entirely when there is no capability", async () => {
		const { sent, mailer } = recorder();
		await emailAdapter.send(
			config,
			{ ...payload, ackUrl: null },
			context(mailer),
		);

		expect(sent[0].message.text).not.toMatch(/https?:/);
		expect(sent[0].message.text).not.toMatch(/done/i);
	});

	it("strips a header break out of the subject and encodes a non-ASCII one", async () => {
		const { sent, mailer } = recorder();
		await emailAdapter.send(
			config,
			{ ...payload, title: "Buy milk\r\nBcc: victim@example.test" },
			context(mailer),
		);
		expect(sent[0].message.subject).toBe("Buy milk Bcc: victim@example.test");

		await emailAdapter.send(
			config,
			{ ...payload, title: "Sortir le chien 🐕" },
			context(mailer),
		);
		expect(sent[1].message.subject).toBe(
			`=?UTF-8?B?${Buffer.from("Sortir le chien 🐕", "utf8").toString("base64")}?=`,
		);
	});

	it("classifies a permanent SMTP rejection as permanent, per category", async () => {
		const cases = [
			{ category: "not_found", smtpCode: 550, code: "not_found" },
			{ category: "auth", smtpCode: 535, code: "auth" },
			{ category: "policy", smtpCode: 554, code: "policy" },
		] as const;
		for (const entry of cases) {
			const { mailer } = recorder({
				ok: false,
				failure: {
					retryable: false,
					category: entry.category,
					smtpCode: entry.smtpCode,
					message: "rejected",
				},
			});
			const result = await emailAdapter.send(config, payload, context(mailer));
			expect(result.ok).toBe(false);
			const decision = classifyRetry(result, 1, 0);
			expect(decision.kind, `smtp ${entry.smtpCode}`).toBe("permanent");
			expect(
				channelErrorCode(decision, (result as { status?: number }).status),
			).toBe(entry.code);
		}
	});

	it("classifies a transient SMTP reply and a dead server as retryable", async () => {
		const transient = recorder({
			ok: false,
			failure: {
				retryable: true,
				category: "rate_limited",
				smtpCode: 451,
				message: "greylisted",
			},
		});
		const throttled = await emailAdapter.send(
			config,
			payload,
			context(transient.mailer),
		);
		expect(classifyRetry(throttled, 1, 0)).toMatchObject({
			kind: "retry",
			retryClass: "throttled",
		});

		const offline = recorder({
			ok: false,
			failure: {
				retryable: true,
				category: "transport",
				message: "connect ECONNREFUSED",
			},
		});
		const down = await emailAdapter.send(
			config,
			payload,
			context(offline.mailer),
		);
		expect(classifyRetry(down, 1, 0)).toMatchObject({
			kind: "retry",
			retryClass: "transport",
		});
	});

	it("never carries the provider's reply text into the result", async () => {
		const { mailer } = recorder({
			ok: false,
			failure: {
				retryable: false,
				category: "auth",
				smtpCode: 535,
				message: "535 5.7.8 auth failed for postmaster@example.test",
			},
		});
		const result = await emailAdapter.send(config, payload, context(mailer));
		expect(JSON.stringify(result)).not.toContain("postmaster");
	});

	it("is permanently undeliverable when SMTP is not configured", async () => {
		const result = await emailAdapter.send(config, payload, context(null));
		expect(result).toMatchObject({ ok: false, policyRejected: true });
		expect(classifyRetry(result, 1, 0)).toMatchObject({ kind: "permanent" });
	});

	it("rejects an unusable stored config without a send", async () => {
		const { sent, mailer } = recorder();
		const result = await emailAdapter.send(
			{ address: "not-an-address" },
			payload,
			context(mailer),
		);
		expect(result).toMatchObject({ ok: false, policyRejected: true });
		expect(sent).toHaveLength(0);
	});

	// The M3a lesson, applied at the adapter level: everything above injects a
	// double, so one case drives the whole path into a real SMTP server.
	it("delivers through the real transport to a real SMTP server", async () => {
		const sink = await startSmtpSink();
		sinks.push(sink);
		const mailer = createMailer({
			host: sink.host,
			port: sink.port,
			implicitTls: false,
			requireTls: false,
			auth: null,
			from: "Ditero <ditero@example.test>",
		});

		const result = await emailAdapter.send(config, payload, context(mailer));

		expect(result).toMatchObject({ ok: true });
		expect(sink.commands).toContainEqual("RCPT TO:<recipient@example.test>");
		expect(sink.messages).toHaveLength(1);
		expect(sink.messages[0]).toContain("Subject: Walk the dog");
		expect(sink.messages[0]).toContain(payload.ackUrl);
	});
});
