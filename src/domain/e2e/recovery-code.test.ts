import { describe, expect, it } from "vitest";
import type { deriveRecoveryKek } from "./kdf.ts";
import {
	CURRENT_RECOVERY_FORMAT,
	formatRecoveryCode,
	generateRecoveryCode,
	MAX_RECOVERY_INPUT_LENGTH,
	normaliseRecoveryCode,
	RECOVERY_ALPHABET,
	RECOVERY_FORMATS,
	RECOVERY_GROUP_SIZE,
	type RecoveryCode,
	RecoveryCodeError,
} from "./recovery-code.ts";

// Known-answer vector. A recovery code is printed on paper and re-entered
// months later, so the alphabet, the group shape, the checksum's domain string
// and its bit packing are all a one-way door: change any of them and every code
// a user already wrote down stops validating. Add a format to RECOVERY_FORMATS
// instead of editing this. Independently reproduced with coreutils:
//   printf 'ditero:recovery:v1|0101010101ABCDEFGHJKMNPQRSTVWX' | sha256sum
//   -> 07911e67..., whose first 25 bits pack MSB-first to 0Y8HW.
const KAT_PAYLOAD = "0101010101ABCDEFGHJKMNPQRSTVWX";
const KAT_CHECKSUM = "0Y8HW";
const KAT_CODE = `01010-10101-ABCDE-FGHJK-MNPQR-STVWX-${KAT_CHECKSUM}`;
const KAT_CANONICAL = `${KAT_PAYLOAD}${KAT_CHECKSUM}` as RecoveryCode;

describe("generateRecoveryCode", () => {
	it("produces a grouped code with a checksum group", async () => {
		const groups = (await generateRecoveryCode()).display.split("-");
		expect(groups).toHaveLength(
			CURRENT_RECOVERY_FORMAT.payloadGroups +
				CURRENT_RECOVERY_FORMAT.checksumGroups,
		);
		for (const group of groups) {
			expect(group).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}$/);
		}
	});

	it("does not repeat", async () => {
		const codes = await Promise.all(
			Array.from({ length: 50 }, () => generateRecoveryCode()),
		);
		expect(new Set(codes.map((c) => c.canonical)).size).toBe(50);
	});

	// Crockford excludes I, L, O and U so a transcribed code has no ambiguous
	// glyph in it to begin with; the normalise-side mapping is the second half
	// of the same guarantee.
	it("never emits an ambiguous glyph", async () => {
		const codes = await Promise.all(
			Array.from({ length: 20 }, () => generateRecoveryCode()),
		);
		expect(codes.map((c) => c.canonical).join("")).not.toMatch(/[ILOU]/);
	});

	// The uniformity the entropy count assumes. A generator drawing from only
	// part of the alphabet still produces a well-formed, non-repeating,
	// unambiguous code of the right length -- every other test here passes
	// against it -- while quietly spending fewer bits per symbol.
	it("draws from the whole alphabet", async () => {
		const codes = await Promise.all(
			Array.from({ length: 40 }, () => generateRecoveryCode()),
		);
		// Payload groups only. The checksum group draws from the whole alphabet
		// whatever the generator does, and at this sample size it covers the
		// alphabet on its own -- which is how the first version of this test
		// passed against a generator restricted to half of it.
		const seen = new Set(
			codes
				.map((code) =>
					code.canonical.slice(0, CURRENT_RECOVERY_FORMAT.payloadLength),
				)
				.join(""),
		);
		for (const symbol of RECOVERY_ALPHABET) {
			expect(seen).toContain(symbol);
		}
	});

	it("round-trips through normalise", async () => {
		const { display, canonical } = await generateRecoveryCode();
		expect(await normaliseRecoveryCode(display)).toBe(canonical);
		expect(formatRecoveryCode(canonical)).toBe(display);
	});

	// A2. deriveKek accepts any non-empty string, so both forms are valid
	// secrets that derive DIFFERENT KEKs. Enrolling under the 41-character
	// display form and unlocking with the 35-character canonical one is
	// permanent key loss, and there is no admin escrow behind it. Compile-time
	// because that is the only place it can be made impossible rather than
	// documented -- and @ts-expect-error fails typecheck if the brand is
	// dropped, so this assertion cannot go vacuous.
	it("makes the display form unusable as a derivation input", async () => {
		const { display, canonical } = await generateRecoveryCode();
		// @ts-expect-error the display form must never reach a KEK derivation
		const wrong: Parameters<typeof deriveRecoveryKek>[0] = display;
		const right: Parameters<typeof deriveRecoveryKek>[0] = canonical;
		expect(wrong).not.toBe(right);
	});
});

describe("normaliseRecoveryCode", () => {
	it("matches the v1 known-answer vector", async () => {
		expect(await normaliseRecoveryCode(KAT_CODE)).toBe(KAT_CANONICAL);
	});

	it("accepts lower case, spaces and missing dashes", async () => {
		const { display, canonical } = await generateRecoveryCode();
		expect(await normaliseRecoveryCode(display.toLowerCase())).toBe(canonical);
		expect(await normaliseRecoveryCode(display.replaceAll("-", " "))).toBe(
			canonical,
		);
		expect(await normaliseRecoveryCode(canonical.toLowerCase())).toBe(
			canonical,
		);
		expect(await normaliseRecoveryCode(`  ${display}\n`)).toBe(canonical);
	});

	// Crockford treats these as the digits they resemble, which is the whole
	// reason to use it for something a human transcribes off paper.
	it("maps look-alike characters to the digits they resemble", async () => {
		const mangled = "OIOLOI OLOI abcde fghjk mnpqr stvwx 0y8hw";
		expect(await normaliseRecoveryCode(mangled)).toBe(KAT_CANONICAL);
	});

	it("rejects U, which Crockford leaves out of the alphabet", async () => {
		const bad = KAT_CODE.replace("STVWX", "STVWU");
		await expect(normaliseRecoveryCode(bad)).rejects.toMatchObject({
			reason: "malformed",
		});
	});

	it("rejects a character outside the alphabet without echoing it", async () => {
		const rejecting = normaliseRecoveryCode(KAT_CODE.replace("A", "é"));
		await expect(rejecting).rejects.toBeInstanceOf(RecoveryCodeError);
		await expect(rejecting).rejects.toMatchObject({ reason: "malformed" });
		// The code is the user's secret. Naming the offending character in a
		// message that may be logged hands over a symbol of it for free.
		await expect(rejecting).rejects.toThrow(
			/^recovery-code: recovery code is not valid \(unrecognised character\)$/,
		);
	});

	// Phase order. A separator the strip pass does not know about is a
	// character problem, not a length problem; reported as a length problem the
	// user hunts for a missing symbol that is not missing.
	it("reports an unstrippable separator as a character, not a length", async () => {
		await expect(
			normaliseRecoveryCode(KAT_CODE.replaceAll("-", "\u2013")),
		).rejects.toMatchObject({ reason: "malformed" });
	});

	// C2. `"\uFB01".toUpperCase()` is "FI" and `"\u00DF".toUpperCase()` is "SS",
	// so a ligature pasted from a styled document expands into two perfectly
	// valid symbols and would reach the checksum stage as a length or checksum
	// fault instead of the character fault it is.
	it("rejects a code point whose upper case expands", async () => {
		for (const bad of [
			KAT_CODE.replace("A", "\uFB01"),
			KAT_CODE.replace("A", "\u00DF"),
		]) {
			await expect(normaliseRecoveryCode(bad)).rejects.toMatchObject({
				reason: "malformed",
			});
		}
	});

	// The desired half of the same pass: Turkish dotless i folds to I, which
	// Crockford reads as 1, and fullwidth forms stay rejected.
	it("folds dotless i to 1 and still rejects fullwidth forms", async () => {
		expect(await normaliseRecoveryCode(KAT_CODE.replace("1", "\u0131"))).toBe(
			KAT_CANONICAL,
		);
		await expect(
			normaliseRecoveryCode(KAT_CODE.replace("A", "\uFF21")),
		).rejects.toMatchObject({ reason: "malformed" });
	});

	it("rejects a code of the wrong length", async () => {
		for (const bad of [
			"ABCDE-ABCDE",
			"",
			KAT_CODE.slice(0, -1),
			`${KAT_CODE}0`,
		]) {
			await expect(normaliseRecoveryCode(bad)).rejects.toMatchObject({
				reason: "length",
			});
		}
	});

	// Bounded before the string is scanned or hashed: this is fed straight from
	// a paste into a text field. Asserted on the detail and not the reason --
	// an over-long input is also rejected by the format dispatch, so a reason
	// assertion alone passes with the cap deleted.
	it("rejects an input past the length cap without scanning it", async () => {
		const rejecting = normaliseRecoveryCode(
			"0".repeat(MAX_RECOVERY_INPUT_LENGTH + 1),
		);
		await expect(rejecting).rejects.toMatchObject({ reason: "length" });
		await expect(rejecting).rejects.toThrow(
			"recovery code is not valid (too long)",
		);
	});

	// The checksum's job: a transcription error must fail here, at entry,
	// rather than surfacing as the indistinguishable "wrong recovery code"
	// after a ~0.5s Argon2 derivation against the wrong KEK.
	it("rejects every single-symbol substitution", async () => {
		const canonical: string = KAT_CANONICAL;
		for (let i = 0; i < canonical.length; i++) {
			const replacement = RECOVERY_ALPHABET[
				(RECOVERY_ALPHABET.indexOf(canonical[i] as string) + 1) %
					RECOVERY_ALPHABET.length
			] as string;
			const typo = canonical.slice(0, i) + replacement + canonical.slice(i + 1);
			expect(typo).not.toBe(canonical);
			await expect(normaliseRecoveryCode(typo)).rejects.toMatchObject({
				reason: "checksum",
			});
		}
	});

	it("rejects a transposition of two adjacent groups", async () => {
		const groups = KAT_CODE.split("-");
		expect(groups[1]).not.toBe(groups[2]);
		const transposed = [
			groups[0] as string,
			groups[2] as string,
			groups[1] as string,
			...groups.slice(3),
		].join("-");
		expect(transposed).not.toBe(KAT_CODE);
		await expect(normaliseRecoveryCode(transposed)).rejects.toMatchObject({
			reason: "checksum",
		});
	});

	it("rejects a code whose checksum group alone was mistranscribed", async () => {
		const groups = KAT_CODE.split("-");
		groups[6] = groups[6] === "00000" ? "11111" : "00000";
		await expect(normaliseRecoveryCode(groups.join("-"))).rejects.toMatchObject(
			{ reason: "checksum" },
		);
	});
});

describe("formatRecoveryCode", () => {
	it("groups a canonical code for printing", () => {
		expect(formatRecoveryCode(KAT_CANONICAL)).toBe(KAT_CODE);
	});

	it("refuses a canonical string of an unknown length", () => {
		const short = "ABCDE" as RecoveryCode;
		expect(() => formatRecoveryCode(short)).toThrow(RecoveryCodeError);
		expect(() => formatRecoveryCode(short)).toThrow(
			"recovery code is not valid (length)",
		);
	});
});

describe("RECOVERY_FORMATS", () => {
	// Keyed by canonical length because the code itself carries no version
	// marker -- spending display characters on one is worse than dispatching on
	// the only discriminant a printed code already has. A constant comparison
	// here would make a second format silently invalidate every printed code.
	it("dispatches on the canonical length of the code", () => {
		const length =
			CURRENT_RECOVERY_FORMAT.payloadLength +
			CURRENT_RECOVERY_FORMAT.checksumLength;
		expect(RECOVERY_FORMATS[length]).toBe(CURRENT_RECOVERY_FORMAT);
	});

	// Constants checked against each other, and labelled as such: this guards a
	// self-contradictory format entry, not the generator's behaviour, which the
	// alphabet-coverage and group-shape tests pin.
	it("keeps the group arithmetic consistent", () => {
		expect(CURRENT_RECOVERY_FORMAT.payloadLength).toBe(
			CURRENT_RECOVERY_FORMAT.payloadGroups * RECOVERY_GROUP_SIZE,
		);
		expect(CURRENT_RECOVERY_FORMAT.checksumLength).toBe(
			CURRENT_RECOVERY_FORMAT.checksumGroups * RECOVERY_GROUP_SIZE,
		);
		const bits =
			CURRENT_RECOVERY_FORMAT.payloadLength *
			Math.log2(RECOVERY_ALPHABET.length);
		expect(bits).toBeGreaterThanOrEqual(128);
	});
});
