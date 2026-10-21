import { afterEach, expect, test } from "vitest";
import {
	getLocale,
	type Locale,
	overwriteGetLocale,
} from "../../paraglide/runtime.js";
import { channelFieldErrorMessage } from "./channel-messages.ts";

const originalGetLocale = getLocale;
afterEach(() => overwriteGetLocale(originalGetLocale));

test.each<[Locale, string]>([
	["en", "This field is required."],
	["de", "Füll dieses Feld aus."],
	["es", "Este campo es obligatorio."],
	["fr", "Ce champ est obligatoire."],
	["ro", "Acest câmp este obligatoriu."],
	["ar", "هذا الحقل مطلوب."],
])("%s required errors are complete sentences independent of field-label grammar", (locale, expected) => {
	overwriteGetLocale(() => locale);
	for (const field of ["publicKey", "channelId", "webhookUrl", "signingSecret"])
		expect(channelFieldErrorMessage("discord", field, "required")).toBe(
			expected,
		);
});

test("invalid fields retain their specific repair guidance", () => {
	overwriteGetLocale(() => "de");
	expect(channelFieldErrorMessage("discord", "publicKey", "invalid")).toBe(
		"Gib den öffentlichen Schlüssel mit 64 Hexadezimalzeichen ein.",
	);
});
