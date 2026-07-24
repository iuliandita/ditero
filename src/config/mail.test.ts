import { describe, expect, it } from "vitest";
import { isMailConfigured, mailConfig } from "./mail.ts";

const base = {
	DITERO_SMTP_HOST: "smtp.example.test",
	DITERO_SMTP_FROM: "Ditero <ditero@example.test>",
	DITERO_SMTP_USER: "postmaster",
	DITERO_SMTP_PASSWORD: "s3cr3t",
};

describe("mailConfig", () => {
	it("returns null with no SMTP host, so a deployment without mail still boots", () => {
		expect(mailConfig({})).toBeNull();
		expect(isMailConfigured({})).toBe(false);
	});

	it("rejects SMTP settings left without a host rather than disabling mail silently", () => {
		expect(() =>
			mailConfig({ DITERO_SMTP_FROM: "ditero@example.test" }),
		).toThrow(/DITERO_SMTP_HOST/);
	});

	it("requires TLS on the default submission port", () => {
		const config = mailConfig(base);
		expect(config).toMatchObject({
			host: "smtp.example.test",
			port: 587,
			implicitTls: false,
			requireTls: true,
			auth: { user: "postmaster", password: "s3cr3t" },
		});
	});

	it("uses implicit TLS on 465 without being told", () => {
		expect(mailConfig({ ...base, DITERO_SMTP_PORT: "465" })).toMatchObject({
			implicitTls: true,
			requireTls: false,
		});
	});

	it("drops the STARTTLS requirement only on the explicit insecure opt-in", () => {
		expect(
			mailConfig({ ...base, DITERO_SMTP_ALLOW_INSECURE: "true" }),
		).toMatchObject({ implicitTls: false, requireTls: false });
	});

	it("refuses an insecure opt-in that contradicts implicit TLS", () => {
		expect(() =>
			mailConfig({
				...base,
				DITERO_SMTP_SECURE: "true",
				DITERO_SMTP_ALLOW_INSECURE: "true",
			}),
		).toThrow(/DITERO_SMTP_SECURE=true/);
	});

	// The same conflict without the variable: implicit TLS came from the port, so
	// naming DITERO_SMTP_SECURE would send the operator hunting for a setting
	// they never made.
	it("blames the port, not an unset variable, when 465 implied implicit TLS", () => {
		expect(() =>
			mailConfig({
				...base,
				DITERO_SMTP_PORT: "465",
				DITERO_SMTP_ALLOW_INSECURE: "true",
			}),
		).toThrow(/DITERO_SMTP_PORT=465/);
	});

	it("rejects a truthy-looking flag value instead of reading it as false", () => {
		for (const raw of ["1", "yes", "TRUE"]) {
			expect(() =>
				mailConfig({ ...base, DITERO_SMTP_ALLOW_INSECURE: raw }),
			).toThrow(/DITERO_SMTP_ALLOW_INSECURE/);
		}
	});

	it("requires user and password together", () => {
		expect(() =>
			mailConfig({ ...base, DITERO_SMTP_PASSWORD: undefined }),
		).toThrow(/together/);
		expect(() => mailConfig({ ...base, DITERO_SMTP_USER: undefined })).toThrow(
			/together/,
		);
	});

	it("accepts a relay with no credentials", () => {
		expect(
			mailConfig({
				DITERO_SMTP_HOST: "localhost",
				DITERO_SMTP_FROM: "ditero@example.test",
			}),
		).toMatchObject({ auth: null });
	});

	it("requires a from-address and rejects one carrying a header break", () => {
		expect(() => mailConfig({ DITERO_SMTP_HOST: "smtp.example.test" })).toThrow(
			/DITERO_SMTP_FROM/,
		);
		expect(() =>
			mailConfig({
				...base,
				DITERO_SMTP_FROM: "ditero@example.test\r\nBcc: evil@example.test",
			}),
		).toThrow(/control characters/);
	});

	it("rejects a port outside the range", () => {
		expect(() => mailConfig({ ...base, DITERO_SMTP_PORT: "70000" })).toThrow(
			/not a port/,
		);
		expect(() => mailConfig({ ...base, DITERO_SMTP_PORT: "0" })).toThrow(
			/positive integer/,
		);
	});
});
