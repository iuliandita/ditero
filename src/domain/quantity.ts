// Shopping quantity and unit rules. The row editor enforces the number format
// on new input; the mutators only bound what is stored, because Zero replays
// offline writes queued before this rule and a legacy "2 boxes" must not be
// dropped on reconnect. Quantities stored as free text still display as-is.

export const QUANTITY_MAX_LENGTH = 10;
export const QUANTITY_STORED_MAX_LENGTH = 32;
export const UNIT_MAX_LENGTH = 16;

// Up to six integer digits and three decimals, with either separator so "1,5"
// works in the locales that write it that way. Stored as typed, not
// normalised, so it reads back in the writer's own notation.
const QUANTITY_RE = /^\d{1,6}(?:[.,]\d{1,3})?$/;

// "" clears the quantity; anything else must be a positive number.
export function isValidQuantity(value: string): boolean {
	if (value === "") return true;
	if (value.length > QUANTITY_MAX_LENGTH || !QUANTITY_RE.test(value))
		return false;
	return Number(value.replace(",", ".")) > 0;
}

// Server bound: trimmed and short, no format check (see above).
export function isStorableQuantity(value: string): boolean {
	return value === value.trim() && value.length <= QUANTITY_STORED_MAX_LENGTH;
}

export function isValidUnit(value: string): boolean {
	return value === value.trim() && value.length <= UNIT_MAX_LENGTH;
}
