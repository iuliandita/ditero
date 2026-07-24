// Auth mail strings. Same Paraglide-shaped contract as src/web/lib/messages.ts
// -- a flat `m` of snake_case keyed functions taking a params object -- so the
// three catalogs merge into the single compiled `m` Paraglide emits per
// project. Split now because these strings are never rendered in the browser.

export const m = {
	auth_mail_verify_subject: () => "Confirm your email address",
	auth_mail_verify_body: (p: { name: string; url: string }) =>
		[
			`Hi ${p.name},`,
			"",
			"Confirm this address to finish setting up your Ditero account:",
			"",
			p.url,
			"",
			"If you did not create an account, ignore this message.",
		].join("\n"),

	auth_mail_reset_subject: () => "Reset your Ditero password",
	auth_mail_reset_body: (p: { name: string; url: string }) =>
		[
			`Hi ${p.name},`,
			"",
			"Use this link to choose a new password:",
			"",
			p.url,
			"",
			"The link expires in an hour and can be used once. If you did not ask",
			"for it, ignore this message -- your password has not changed.",
		].join("\n"),

	auth_mail_greeting_fallback: () => "there",

	auth_mail_not_configured: () =>
		"This server cannot send email, so password resets by email are unavailable. Ask your administrator to reset your password or to configure SMTP.",
} as const;
