import type { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { FieldKeyRing } from "../security/field-encryption.ts";
import { decryptField, encryptField } from "../security/field-encryption.ts";

type AdapterFactory = ReturnType<typeof drizzleAdapter>;

export const sensitiveAuthFields: Record<string, string[]> = {
	account: ["accessToken", "refreshToken", "idToken"],
	jwks: ["privateKey"],
	twoFactor: ["secret", "backupCodes"],
};

export function authFieldContext(model: string, field: string): string {
	return `better-auth:${model}:${field}`;
}

function transformRecord(
	model: string,
	record: unknown,
	ring: FieldKeyRing,
	direction: "encrypt" | "decrypt",
): unknown {
	if (!record || typeof record !== "object" || Array.isArray(record))
		return record;
	const fields = sensitiveAuthFields[model];
	if (!fields) return record;
	const transformed = { ...(record as Record<string, unknown>) };
	for (const field of fields) {
		const value = transformed[field];
		if (typeof value !== "string" || !value) continue;
		const context = authFieldContext(model, field);
		if (direction === "encrypt") {
			if (!value.startsWith("ditero:v1:")) {
				transformed[field] = encryptField(value, context, ring);
			}
		} else if (value.startsWith("ditero:v1:")) {
			transformed[field] = decryptField(value, context, ring).plaintext;
		}
	}
	return transformed;
}

function transformOutput(
	model: string,
	output: unknown,
	ring: FieldKeyRing,
): unknown {
	return Array.isArray(output)
		? output.map((record) => transformRecord(model, record, ring, "decrypt"))
		: transformRecord(model, output, ring, "decrypt");
}

function wrapAdapter<T extends object>(adapter: T, ring: FieldKeyRing): T {
	return new Proxy(adapter, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function") return value;

			if (property === "create") {
				return async (input: {
					model: string;
					data: Record<string, unknown>;
				}) => {
					const output = await Reflect.apply(value, target, [
						{
							...input,
							data: transformRecord(input.model, input.data, ring, "encrypt"),
						},
					]);
					return transformOutput(input.model, output, ring);
				};
			}

			if (property === "update" || property === "updateMany") {
				return async (input: {
					model: string;
					update: Record<string, unknown>;
				}) => {
					const output = await Reflect.apply(value, target, [
						{
							...input,
							update: transformRecord(
								input.model,
								input.update,
								ring,
								"encrypt",
							),
						},
					]);
					return transformOutput(input.model, output, ring);
				};
			}

			if (property === "incrementOne") {
				return async (input: {
					model: string;
					where: Array<{
						field: string;
						value: unknown;
						operator?: string;
					}>;
					increment: Record<string, number>;
					set?: Record<string, unknown>;
				}) => {
					const fields = sensitiveAuthFields[input.model] ?? [];
					const sensitiveWhere = input.where.filter((clause) =>
						fields.includes(clause.field),
					);
					let where = input.where;
					if (sensitiveWhere.length > 0) {
						const publicWhere = input.where.filter(
							(clause) => !fields.includes(clause.field),
						);
						if (publicWhere.length === 0) {
							throw new Error(
								"Encrypted field guards require a non-sensitive selector",
							);
						}
						if (
							sensitiveWhere.some(
								(clause) => clause.operator && clause.operator !== "eq",
							)
						) {
							throw new Error("Encrypted fields support equality guards only");
						}
						const findOne = Reflect.get(target, "findOne");
						if (typeof findOne !== "function") return null;
						const raw = (await Reflect.apply(findOne, target, [
							{
								model: input.model,
								where: publicWhere,
							},
						])) as Record<string, unknown> | null;
						if (!raw) return null;
						const decrypted = transformRecord(
							input.model,
							raw,
							ring,
							"decrypt",
						) as Record<string, unknown>;
						if (
							sensitiveWhere.some(
								(clause) => decrypted[clause.field] !== clause.value,
							)
						) {
							return null;
						}
						where = input.where.map((clause) =>
							fields.includes(clause.field)
								? { ...clause, value: raw[clause.field] }
								: clause,
						);
					}
					const output = await Reflect.apply(value, target, [
						{
							...input,
							where,
							set: input.set
								? transformRecord(input.model, input.set, ring, "encrypt")
								: undefined,
						},
					]);
					return transformOutput(input.model, output, ring);
				};
			}

			if (
				property === "findOne" ||
				property === "findMany" ||
				property === "consumeOne"
			) {
				return async (input: { model: string }) =>
					transformOutput(
						input.model,
						await Reflect.apply(value, target, [input]),
						ring,
					);
			}

			if (property === "transaction") {
				return async (callback: (transaction: object) => Promise<unknown>) =>
					Reflect.apply(value, target, [
						(transaction: object) => callback(wrapAdapter(transaction, ring)),
					]);
			}

			return value.bind(target);
		},
	});
}

export function withFieldEncryption(
	adapterFactory: AdapterFactory,
	ring: FieldKeyRing,
): AdapterFactory {
	return (options) => wrapAdapter(adapterFactory(options), ring);
}
