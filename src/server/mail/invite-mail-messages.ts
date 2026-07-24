// Invite mail strings. Same Paraglide-shaped contract as src/web/lib/messages.ts
// -- a flat `m` of snake_case keyed functions taking a params object -- and a
// separate file for the same reason src/auth/mail-messages.ts is: these two are
// never rendered in the browser. The inviter-facing status notices, which are,
// stay in the web catalog. All three merge into the single compiled `m`
// Paraglide emits per project.
//
// Both parameters are user-controlled and reach a header, so the caller runs
// them through headerSafe/encodeHeaderValue. Nothing here is HTML.

export const m = {
	invite_mail_subject: (p: { inviter: string; workspace: string }) =>
		`${p.inviter} invited you to ${p.workspace} on Ditero`,
	invite_mail_body: (p: { inviter: string; workspace: string; link: string }) =>
		[
			`${p.inviter} invited you to join ${p.workspace} on Ditero.`,
			"",
			"Accept the invitation:",
			p.link,
			"",
			"If you were not expecting this, you can ignore this email.",
		].join("\n"),
} as const;
