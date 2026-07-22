import { describe, expect, it } from "vitest";
import {
	DEFAULT_LONG_POLL_SEC,
	DEFAULT_MAX_BOTS,
	telegramMode,
	telegramPollTiming,
} from "./telegram.ts";

describe("telegramMode", () => {
	it("defaults to poll", () => {
		expect(telegramMode({})).toBe("poll");
		expect(telegramMode({ DITERO_TELEGRAM_MODE: "  " })).toBe("poll");
	});

	it("accepts both transports", () => {
		expect(telegramMode({ DITERO_TELEGRAM_MODE: "poll" })).toBe("poll");
		expect(telegramMode({ DITERO_TELEGRAM_MODE: " webhook " })).toBe("webhook");
	});

	// A typo must not silently fall back to polling while the operator believes
	// the webhook is live: the two are mutually exclusive at the provider.
	it("rejects anything else at boot", () => {
		expect(() => telegramMode({ DITERO_TELEGRAM_MODE: "Webhook" })).toThrow(
			/DITERO_TELEGRAM_MODE/,
		);
		expect(() => telegramMode({ DITERO_TELEGRAM_MODE: "both" })).toThrow(
			/DITERO_TELEGRAM_MODE/,
		);
	});
});

describe("telegramPollTiming", () => {
	it("defaults", () => {
		expect(telegramPollTiming({})).toEqual({
			longPollSec: DEFAULT_LONG_POLL_SEC,
			maxBots: DEFAULT_MAX_BOTS,
		});
	});

	it("reads overrides", () => {
		expect(
			telegramPollTiming({
				DITERO_TELEGRAM_POLL_TIMEOUT_SEC: "5",
				DITERO_TELEGRAM_MAX_BOTS: "3",
			}),
		).toEqual({ longPollSec: 5, maxBots: 3 });
	});

	it("rejects a poll window no intermediary would hold open", () => {
		expect(() =>
			telegramPollTiming({ DITERO_TELEGRAM_POLL_TIMEOUT_SEC: "120" }),
		).toThrow(/at most 60/);
	});

	it("rejects non-positive values", () => {
		expect(() =>
			telegramPollTiming({ DITERO_TELEGRAM_POLL_TIMEOUT_SEC: "0" }),
		).toThrow(/positive integer/);
		expect(() =>
			telegramPollTiming({ DITERO_TELEGRAM_MAX_BOTS: "-1" }),
		).toThrow(/positive integer/);
	});
});
