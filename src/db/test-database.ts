const E2E_DATABASE_NAME = "ditero_e2e";

export function assertSafeTestDatabase(
	databaseURL: string | undefined,
	nodeEnv: string | undefined,
): asserts databaseURL is string {
	let databaseName: string | undefined;
	try {
		databaseName = databaseURL
			? new URL(databaseURL).pathname.replace(/^\/+/, "")
			: undefined;
	} catch {
		databaseName = undefined;
	}

	if (nodeEnv !== "test" || databaseName !== E2E_DATABASE_NAME) {
		throw new Error(
			`Refusing destructive E2E seed: NODE_ENV must be test and database must be ${E2E_DATABASE_NAME}`,
		);
	}
}
