// Shopping quantity and unit rules, shared by the row editor and the mutators
// so the server refuses what the client would. Only new writes are checked:
// quantities stored as free text before these rules still display as-is.

export const QUANTITY_MAX_LENGTH = 10;
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

export function isValidUnit(value: string): boolean {
	return value === value.trim() && value.length <= UNIT_MAX_LENGTH;
}
