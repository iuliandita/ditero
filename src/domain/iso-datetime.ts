import { z } from "zod";

// Zod 4.6 requires seconds by default; our timestamp contract also allows minutes.
export function isoDateTimeSchema(options: { offset?: boolean } = {}) {
	return z.union([
		z.iso.datetime(options),
		z.iso.datetime({ ...options, precision: -1 }),
	]);
}
