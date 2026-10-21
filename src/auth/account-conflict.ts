import { APIError } from "better-auth";
import type { drizzleAdapter } from "better-auth/adapters/drizzle";

type AdapterFactory = ReturnType<typeof drizzleAdapter>;

export const ACCOUNT_KEY_INDEX = "account_provider_account_uidx";

function violatesAccountKey(error: unknown): boolean {
	for (let cause = error, depth = 0; cause && depth < 4; depth++) {
		const { code, constraint, cause: next } = cause as Record<string, unknown>;
		if (code === "23505" && constraint === ACCOUNT_KEY_INDEX) return true;
		cause = next;
	}
	return false;
}

// Two concurrent flows for one provider account both pass Better Auth's
// owner lookup; the unique index admits one insert. Turn the loser's database
// error into a coded refusal instead of an opaque 500.
function wrapAdapter<T extends object>(adapter: T): T {
	return new Proxy(adapter, {
		get(target, property) {
			const value = Reflect.get(target, property);
			if (typeof value !== "function") return value;
			if (property === "create") {
				return async (input: { model: string }) => {
					try {
						return await Reflect.apply(value, target, [input]);
					} catch (error) {
						if (input.model === "account" && violatesAccountKey(error)) {
							throw new APIError("CONFLICT", {
								code: "ACCOUNT_ALREADY_LINKED",
								message: "This provider account is already linked",
							});
						}
						throw error;
					}
				};
			}
			if (property === "transaction") {
				return (callback: (transaction: object) => Promise<unknown>) =>
					Reflect.apply(value, target, [
						(transaction: object) => callback(wrapAdapter(transaction)),
					]);
			}
			return value.bind(target);
		},
	});
}

export function withAccountConflict(
	adapterFactory: AdapterFactory,
): AdapterFactory {
	return (options) => wrapAdapter(adapterFactory(options));
}
