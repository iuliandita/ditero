// Pinned node-postgres Client only: one session, never a Pool or reconnecting adapter.
export const LOCK = Object.freeze([0x44495445, 0x4d494752]);
export async function withMigrationLock(
	client,
	migrate,
	{
		connectMs = 5000,
		acquisitionMs = 30000,
		queryMs = 5000,
		migrationMs = 600000,
		closeMs = 5000,
		retryMs = 100,
		now = () => performance.now(),
		sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	} = {},
) {
	for (const value of [
		connectMs,
		acquisitionMs,
		queryMs,
		migrationMs,
		closeMs,
		retryMs,
	]) {
		if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
			throw new Error("invalid migration deadline");
	}
	let connected = false,
		locked = false,
		terminated = false,
		firstError;
	const terminate = () => {
		terminated = true;
		// Pinned pg Client.end uses this same stream destruction for active queries.
		// Explicit destruction also covers idle/hung callback expiry; no reconnect is allowed.
		client.connection.stream.destroy();
	};
	let rejectLoss;
	const loss = new Promise((_, reject) => {
		rejectLoss = reject;
	});
	loss.catch(() => {});
	client.on("error", () => {
		if (!terminated) {
			firstError ??= new Error("migration session lost");
			terminate();
			rejectLoss(firstError);
		}
	});
	async function bounded(operation, ms, label, includeLoss = true) {
		let timer;
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => {
				terminate();
				reject(new Error(`${label} deadline exceeded`));
			}, ms);
		});
		try {
			return await Promise.race([
				Promise.resolve().then(operation),
				timeout,
				...(includeLoss ? [loss] : []),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	try {
		await bounded(() => client.connect(), connectMs, "connection");
		connected = true;
		const deadline = now() + acquisitionMs;
		for (;;) {
			const remaining = deadline - now();
			if (remaining <= 0)
				throw new Error("migration lock acquisition deadline exceeded");
			const result = await bounded(
				() =>
					client.query(
						"SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired",
						LOCK,
					),
				Math.min(queryMs, remaining),
				"lock acquisition",
			);
			if (
				result.rows.length !== 1 ||
				typeof result.rows[0].acquired !== "boolean"
			) {
				throw new Error("invalid migration lock response");
			}
			if (result.rows[0].acquired) {
				locked = true;
				if (now() > deadline)
					throw new Error("migration lock acquisition deadline exceeded");
				break;
			}
			// The ordinary retry delay is not a query; never race equal-duration timers.
			await Promise.race([
				sleep(Math.min(retryMs, Math.max(1, deadline - now()))),
				loss,
			]);
		}
		await bounded(() => migrate(client), migrationMs, "migration");
	} catch (error) {
		firstError ??= error;
	} finally {
		try {
			if (connected && locked && !terminated) {
				const result = await bounded(
					() =>
						client.query(
							"SELECT pg_advisory_unlock($1::integer, $2::integer) AS released",
							LOCK,
						),
					queryMs,
					"lock release",
				);
				if (result.rows.length !== 1 || result.rows[0].released !== true) {
					firstError ??= new Error("migration lock release failed");
				}
			}
		} catch (error) {
			firstError ??= error;
		} finally {
			try {
				await bounded(() => client.end(), closeMs, "connection close", false);
			} catch (error) {
				firstError ??= error;
			}
		}
	}
	// Keep the error listener: late transport errors cannot become unhandled events.
	if (firstError) throw firstError;
}
