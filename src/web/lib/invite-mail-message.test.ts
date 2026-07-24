import { describe, expect, it } from "vitest";
import type { InviteMailStatus } from "../../domain/invite.ts";
import { inviteMailMessage } from "./channel-messages.ts";

describe("inviteMailMessage", () => {
	it("says nothing for a link invite that was never going to be mailed", () => {
		expect(inviteMailMessage({ status: "skipped" }, "")).toBeNull();
	});

	it("confirms a delivered invite and names the address", () => {
		expect(inviteMailMessage({ status: "sent" }, "a@b.test")).toEqual({
			text: "Invitation emailed to a@b.test.",
			tone: "info",
		});
	});

	// Every non-sent outcome has to reach the inviter as a warning: the whole
	// point is that "I invited them" must not be a silent lie.
	it.each([
		{ status: "smtp_disabled" },
		{ status: "no_public_url" },
		{ status: "invalid_address" },
		{ status: "failed", retryable: true, category: "transport" },
		{ status: "failed", retryable: false, category: "not_found" },
	] as InviteMailStatus[])("warns on %o", (mail) => {
		const message = inviteMailMessage(mail, "a@b.test");
		expect(message?.tone).toBe("warning");
		expect(message?.text).not.toBe("");
	});

	// The two failure copies differ: one tells the inviter it may still arrive,
	// the other that it will not.
	it("distinguishes a retryable failure from a permanent one", () => {
		const retryable = inviteMailMessage(
			{ status: "failed", retryable: true, category: "transport" },
			"a@b.test",
		);
		const permanent = inviteMailMessage(
			{ status: "failed", retryable: false, category: "not_found" },
			"a@b.test",
		);
		expect(retryable?.text).not.toBe(permanent?.text);
		expect(permanent?.text).toMatch(/will not arrive/);
	});
});
