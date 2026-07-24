import { describe, expect, it } from "vitest";
import { channelCapabilities, interactionsUrls } from "./channels.ts";

const SMTP = {
	DITERO_SMTP_HOST: "smtp.example.com",
	DITERO_SMTP_FROM: "ditero@example.com",
};

describe("channelCapabilities", () => {
	it("reports booleans and enums only, never the env values", () => {
		const caps = channelCapabilities({
			DITERO_PUBLIC_URL: "https://ditero.example.com",
			DITERO_TELEGRAM_MODE: "webhook",
			...SMTP,
		});
		expect(caps).toEqual({
			ackBaseUrl: true,
			email: true,
			telegramTransport: "webhook",
			telegramWebhookConfigurable: true,
		});
		// The settings page must not be able to read the deployment's config out
		// of its own capability probe.
		expect(JSON.stringify(caps)).not.toContain("ditero.example.com");
		expect(JSON.stringify(caps)).not.toContain("smtp.example.com");
	});

	it("is fail-closed on a bare deployment", () => {
		expect(channelCapabilities({})).toEqual({
			ackBaseUrl: false,
			email: false,
			telegramTransport: "poll",
			telegramWebhookConfigurable: true,
		});
	});

	it("calls the Telegram webhook transport unhealthy without a public URL", () => {
		expect(
			channelCapabilities({ DITERO_TELEGRAM_MODE: "webhook" })
				.telegramWebhookConfigurable,
		).toBe(false);
		// Poll needs no public URL, so its absence is not a fault.
		expect(
			channelCapabilities({ DITERO_TELEGRAM_MODE: "poll" })
				.telegramWebhookConfigurable,
		).toBe(true);
	});

	it("separates SMTP from the public URL", () => {
		expect(channelCapabilities(SMTP)).toMatchObject({
			ackBaseUrl: false,
			email: true,
		});
		expect(
			channelCapabilities({ DITERO_PUBLIC_URL: "https://x.example" }),
		).toMatchObject({ ackBaseUrl: true, email: false });
	});
});

describe("interactionsUrls", () => {
	it("builds both provider URLs from the public origin", () => {
		expect(
			interactionsUrls({ DITERO_PUBLIC_URL: "https://ditero.example.com//" }),
		).toEqual({
			discord:
				"https://ditero.example.com/api/notifications/discord/interactions",
			slack: "https://ditero.example.com/api/notifications/slack/interactions",
		});
	});

	it("is null when there is no public origin to paste", () => {
		expect(interactionsUrls({})).toBeNull();
	});
});
