import { Elysia } from "elysia";
import type { Pool } from "pg";
import { z } from "zod";
import { e2eEnabled } from "../../config/e2e.ts";
import type { db as defaultDb } from "../../db/client.ts";
import { withUserContext } from "../../db/user-context.ts";
import { KDF_PARAMS } from "../../domain/e2e/kdf.ts";
import { isWellFormedCommitment } from "../../domain/e2e/wdk-commitment.ts";
import type { Guards } from "../guards.ts";
import {
	type GrantFailure,
	markGrantFailed,
	myGrants,
	myWorkspaceKeys,
	notifyGrantCapable,
	pendingGrants,
	requestWorkspaceKey,
	submitGrant,
} from "./grants.ts";
import { type RotationFailure, rotateIdentity } from "./identity-rotation.ts";
import {
	e2eBlobSchema as blob,
	e2ePublicKeySchema as publicKey,
} from "./input.ts";
import {
	type ProvisionFailure,
	pendingProvisions,
	provisionWorkspace,
} from "./provision.ts";
import {
	rotateWorkspace,
	type WorkspaceRotationFailure,
	workspaceRotationPlan,
} from "./rotation.ts";

// #168. The version the CLIENT derived its wraps under, validated against the
// registry and then stored verbatim. The server must never substitute its own
// CURRENT_KDF_VERSION: a client one release behind would have a v1 wrap recorded
// as v2, and the unlock path re-derives from the stored version, so every future
// unlock fails with a correct passphrase. Object.hasOwn, not `in` or an index
// read, because a numeric registry is still reachable through the prototype.
const formatVersion = z
	.number()
	.int()
	.refine(
		(value) => Object.hasOwn(KDF_PARAMS, value),
		"formatVersion must be a registered KDF version",
	);

// One wrap being replaced, plus the value it is replacing. The previous wrap
// is the compare-and-set token rather than the row's `updatedAt`: a timestamptz
// carries microseconds that JSON's millisecond Date does not, so a timestamp
// token either loses precision on the way out and never matches again, or
// matches a DIFFERENT write that landed inside the same millisecond. The wrap
// is exact, needs no clock, and the client already holds it -- it just
// decrypted the thing.
const wrapReplacement = z.object({
	wrapped: blob,
	salt: blob,
	previousWrapped: blob,
});

const rewrapBody = z
	.object({
		passphrase: wrapReplacement.optional(),
		recovery: wrapReplacement.optional(),
		formatVersion,
	})
	.refine(
		(value) => value.passphrase !== undefined || value.recovery !== undefined,
		"at least one wrap must be replaced",
	);

const rotateBody = z.object({
	publicKey,
	// The identity being replaced, as a compare-and-set token. Same reasoning as
	// the rewrap endpoint's previousWrapped: a client that computed a rotation
	// against one identity must not have it applied to a different one, and the
	// public key is exact, clock-free and already in the client's hand.
	previousPublicKey: publicKey,
	passphraseWrapped: blob,
	recoveryWrapped: blob,
	passphraseSalt: blob,
	recoverySalt: blob,
	formatVersion,
	rewraps: z
		.array(
			z.object({
				membershipKeyId: z.string().min(1).max(128),
				enc: blob,
				ciphertext: blob,
			}),
		)
		// A workspace count, not a payload size: the cap exists so one request
		// cannot be used as bulk storage, and is far above any plausible number
		// of workspace key versions a single user holds.
		.max(1000),
});

// Two failures mean "you changed nothing and may retry after re-reading", and
// two mean "this request is wrong". Splitting them here rather than in the
// module keeps the HTTP vocabulary out of code that has no other reason to
// know it.
const ROTATION_STATUS: Record<RotationFailure, number> = {
	"not-enrolled": 409,
	"stale-previous-key": 409,
	"unchanged-key": 400,
	"incomplete-rewraps": 400,
};

// Delegated to the domain recognizer rather than restated as a regex here. The
// server can only ever check a commitment's SHAPE -- it holds no WDK -- and a
// hand-written pattern would quietly stop matching the day a v2 committer lands
// with a different digest shape, refusing correct commitments outright.
const commitment = z
	.string()
	.max(256)
	.refine(isWellFormedCommitment, "malformed WDK commitment");

const workspaceRotateBody = z.object({
	previousVersion: z.number().int().positive().max(2_147_483_646),
	commitment,
	grants: z
		.array(
			z.object({
				membershipId: z.string().min(1).max(128),
				userId: z.string().min(1).max(128),
				recipientPublicKey: publicKey,
				enc: blob,
				ciphertext: blob,
			}),
		)
		.max(1000),
});

const WORKSPACE_ROTATION_STATUS: Record<WorkspaceRotationFailure, number> = {
	"not-found": 404,
	"not-permitted": 403,
	"not-enrolled": 409,
	"not-required": 409,
	"no-active-key": 409,
	"stale-version": 409,
	"incomplete-grants": 409,
	"stale-recipient-key": 409,
};

function workspaceIdFromPath(
	request: Request,
	prefix: string,
	suffix: string,
): string | null {
	const path = new URL(request.url).pathname;
	if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
	const encoded = path.slice(prefix.length, path.length - suffix.length);
	if (!encoded || encoded.includes("/")) return null;
	try {
		const decoded = decodeURIComponent(encoded);
		return decoded.length <= 128 && !decoded.includes("/") ? decoded : null;
	} catch {
		return null;
	}
}

const provisionBody = z.object({
	workspaceId: z.string().min(1).max(128),
	commitment,
	enc: blob,
	ciphertext: blob,
});

const PROVISION_STATUS: Record<ProvisionFailure, number> = {
	// Deliberately the same status for "not a member" and "wrong role": the
	// distinction tells a stranger the workspace exists.
	"not-permitted": 403,
	"not-enrolled": 409,
};

const grantBody = z.object({
	requestId: z.string().min(1).max(128),
	recipientPublicKey: publicKey,
	enc: blob,
	ciphertext: blob,
});

const requestGrantBody = z.object({
	workspaceId: z.string().min(1).max(128),
});

const grantFailBody = z.object({
	requestId: z.string().min(1).max(128),
	// A short free-text reason from the recipient's own client, shown back to
	// them. Capped because it is stored verbatim.
	reason: z.string().min(1).max(200),
});

const GRANT_STATUS: Record<GrantFailure, number> = {
	// Absent rather than forbidden: a request id the caller cannot fulfil and a
	// request id that does not exist must look the same, or the endpoint
	// enumerates other workspaces' pending grants.
	"no-request": 404,
	"not-ready": 409,
	"inactive-version": 409,
	"stale recipient key": 409,
	conflict: 409,
};

const enrollBody = z.object({
	publicKey,
	passphraseWrapped: blob,
	recoveryWrapped: blob,
	passphraseSalt: blob,
	recoverySalt: blob,
	formatVersion,
});

export function e2eRoutes(
	pool: Pool,
	database: typeof defaultDb,
	guards: Guards,
) {
	return new Elysia()
		.get(
			"/api/e2e/members/:workspaceId/keys",
			guards.guardedGet(async (request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				const workspaceId = workspaceIdFromPath(
					request,
					"/api/e2e/members/",
					"/keys",
				);
				if (!workspaceId) return new Response("Bad Request", { status: 400 });
				return await withUserContext(pool, session.user.id, async (client) => {
					const plan = await workspaceRotationPlan(
						client,
						session.user.id,
						workspaceId,
					);
					return plan ?? new Response("Not Found", { status: 404 });
				});
			}),
		)
		.post(
			"/api/e2e/workspaces/:workspaceId/rotate",
			guards.guardedPost(async (request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				const workspaceId = workspaceIdFromPath(
					request,
					"/api/e2e/workspaces/",
					"/rotate",
				);
				if (!workspaceId) return new Response("Bad Request", { status: 400 });
				let parsed: z.infer<typeof workspaceRotateBody>;
				try {
					parsed = workspaceRotateBody.parse(await request.json());
				} catch {
					return new Response("Bad Request", { status: 400 });
				}
				return await withUserContext(pool, session.user.id, async (client) => {
					const result = await rotateWorkspace(
						client,
						session.user.id,
						workspaceId,
						parsed,
					);
					if (!result.ok) {
						return new Response(result.reason, {
							status: WORKSPACE_ROTATION_STATUS[result.reason],
						});
					}
					return {
						workspaceId: result.workspaceId,
						version: result.version,
						commitment: result.commitment,
						outcome: result.outcome,
					};
				});
			}),
		)
		.get(
			"/api/e2e/identity",
			guards.guardedGet(async (_request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				return await withUserContext(pool, session.user.id, async (client) => {
					const stored = await client.query<{
						public_key: string;
						format_version: number;
						passphrase_wrapped: string;
						passphrase_salt: string;
					}>(
						// An inner join, so a user_key row whose secret half is
						// unreadable reports "not enrolled" rather than an identity
						// with null wraps the unlock path would try to derive from.
						`select k.public_key, s.format_version, s.passphrase_wrapped,
						 s.passphrase_salt
						 from user_key k join user_key_secret s on s.user_key_id = k.id
						 where k.user_id = $1 and k.retired_at is null`,
						[session.user.id],
					);
					const row = stored.rows[0];
					// The passphrase wrap and its salt are the unlock path's input and
					// are returned to their owner only -- withUserContext plus the
					// row's RLS policy make that structural. The RECOVERY wrap is
					// deliberately withheld: it opens the same private key under a
					// secret the user is told to keep offline, so a read that only
					// asks "can I unlock here?" has no reason to carry it. Task 12's
					// recover path fetches it on its own route.
					return row
						? {
								enrolled: true,
								publicKey: row.public_key,
								formatVersion: row.format_version,
								passphraseWrapped: row.passphrase_wrapped,
								passphraseSalt: row.passphrase_salt,
							}
						: {
								enrolled: false,
								publicKey: null,
								formatVersion: null,
								passphraseWrapped: null,
								passphraseSalt: null,
							};
				});
			}),
		)
		.post(
			"/api/e2e/enroll",
			guards.guardedPost(async (request, session) => {
				// Read per request, not at mount time: the flag decides whether the
				// feature EXISTS, and a disabled deployment must answer 404 rather
				// than 403 -- a 403 tells an unauthenticated prober that the feature
				// is there and merely closed to them.
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });

				let parsed: z.infer<typeof enrollBody>;
				try {
					parsed = enrollBody.parse(await request.json());
				} catch {
					return new Response("Bad Request", { status: 400 });
				}

				const userId = session.user.id;
				return await withUserContext(pool, userId, async (client) => {
					// Insert-then-read, not read-then-insert: two concurrent first
					// enrollments both reach the insert, one wins, and both then read
					// the same winning row. The read-first order would let both decide
					// they are the first and race on the write.
					// One statement across both tables, so a first enrolment cannot
					// commit an identity whose wraps are missing -- a state with no
					// recovery path, since the public key is then immutable and no
					// passphrase opens anything. The CTE returns no row when the
					// conflict fires, so the second insert is skipped for free.
					await client.query(
						`with identity as (
						 insert into user_key (id, user_id, public_key, state)
						 values ($1, $2, $3, 'ready')
						 on conflict (user_id) where retired_at is null do nothing
						 returning id, user_id)
					 insert into user_key_secret (user_key_id, user_id,
					 passphrase_wrapped, recovery_wrapped, passphrase_salt,
					 recovery_salt, format_version)
					 select id, user_id, $4, $5, $6, $7, $8 from identity`,
						[
							`uk_${crypto.randomUUID()}`,
							userId,
							parsed.publicKey,
							parsed.passphraseWrapped,
							parsed.recoveryWrapped,
							parsed.passphraseSalt,
							parsed.recoverySalt,
							parsed.formatVersion,
						],
					);

					const stored = await client.query<{
						public_key: string;
						state: string;
					}>(
						`select public_key, state from user_key
						 where user_id = $1 and retired_at is null`,
						[userId],
					);
					const row = stored.rows[0];
					if (!row) return new Response("Conflict", { status: 409 });

					// An enrolled identity is immutable. Replacing one is identity
					// rotation, which has preconditions this endpoint does not check.
					// format_version needs no comparable check: `do nothing` already
					// makes it unwritable after the first enroll, and while the registry
					// holds one version a matching public key cannot arrive under a
					// different one. Revisit when a v2 is registered.
					if (row.public_key !== parsed.publicKey) {
						return new Response("Conflict", { status: 409 });
					}
					// Never echo a wrapped blob or a salt: the response is the state,
					// not the material.
					return { publicKey: row.public_key, state: row.state };
				});
			}),
		)
		.get(
			"/api/e2e/identity/recovery",
			guards.guardedGet(async (_request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				return await withUserContext(pool, session.user.id, async (client) => {
					// Its own route, so that the ordinary "can I unlock here?" read
					// never carries the recovery wrap. Same owner, same RLS policy --
					// the separation is about not handing the offline-secret wrap to
					// every page load, not about a stronger check being possible.
					const stored = await client.query<{
						recovery_wrapped: string;
						recovery_salt: string;
						format_version: number;
					}>(
						`select s.recovery_wrapped, s.recovery_salt, s.format_version
						 from user_key k join user_key_secret s on s.user_key_id = k.id
						 where k.user_id = $1 and k.retired_at is null`,
						[session.user.id],
					);
					const row = stored.rows[0];
					return row
						? {
								enrolled: true,
								recoveryWrapped: row.recovery_wrapped,
								recoverySalt: row.recovery_salt,
								formatVersion: row.format_version,
							}
						: {
								enrolled: false,
								recoveryWrapped: null,
								recoverySalt: null,
								formatVersion: null,
							};
				});
			}),
		)
		.post(
			"/api/e2e/rewrap",
			guards.guardedPost(async (request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });

				let parsed: z.infer<typeof rewrapBody>;
				try {
					parsed = rewrapBody.parse(await request.json());
				} catch {
					return new Response("Bad Request", { status: 400 });
				}

				// The server cannot check that these wraps open to the private key
				// matching the immutable public key -- they are opaque to it. A
				// session that has been taken over can therefore destroy an
				// identity by overwriting both wraps with junk. It cannot READ
				// anything by doing so: every WDK is wrapped to the public key,
				// which no request can change. Availability, not confidentiality.
				const userId = session.user.id;
				return await withUserContext(pool, userId, async (client) => {
					const stored = await client.query<{ format_version: number }>(
						`select s.format_version
						 from user_key k join user_key_secret s on s.user_key_id = k.id
						 where k.user_id = $1 and k.state = 'ready'
						 and k.retired_at is null`,
						[userId],
					);
					const row = stored.rows[0];
					if (!row) return new Response("Conflict", { status: 409 });

					// One column holds the version for BOTH wraps, so only a rewrap
					// that replaces both may move it. Letting a partial rewrap change
					// it would re-stamp the untouched wrap with a version it was never
					// derived under -- #168 exactly, one endpoint later, and equally
					// unfixable by any secret the user knows.
					const partial = !parsed.passphrase || !parsed.recovery;
					if (partial && parsed.formatVersion !== row.format_version) {
						return new Response("Bad Request", { status: 400 });
					}

					const params: unknown[] = [userId];
					const bind = (value: unknown) => {
						params.push(value);
						return `$${params.length}`;
					};
					const sets: string[] = [];
					const guardsSql: string[] = [];
					if (parsed.passphrase) {
						sets.push(
							`passphrase_wrapped = ${bind(parsed.passphrase.wrapped)}`,
							`passphrase_salt = ${bind(parsed.passphrase.salt)}`,
						);
						guardsSql.push(
							`passphrase_wrapped = ${bind(parsed.passphrase.previousWrapped)}`,
						);
					}
					if (parsed.recovery) {
						sets.push(
							`recovery_wrapped = ${bind(parsed.recovery.wrapped)}`,
							`recovery_salt = ${bind(parsed.recovery.salt)}`,
						);
						guardsSql.push(
							`recovery_wrapped = ${bind(parsed.recovery.previousWrapped)}`,
						);
					}
					sets.push(
						`format_version = ${bind(parsed.formatVersion)}`,
						"updated_at = now()",
					);

					// One statement, so the recovery reset cannot land its new
					// passphrase and then fail to land its new recovery code --
					// which would leave the account reachable by a code the user
					// has just typed into a field and been told is dead.
					const updated = await client.query(
						`update user_key_secret s set ${sets.join(", ")}
						 from user_key k
						 where k.id = s.user_key_id and s.user_id = $1
						 and k.state = 'ready' and k.retired_at is null
						 and ${guardsSql.join(" and ")}`,
						params,
					);
					// Zero rows means the wrap moved under this caller since it was
					// read. The loser of a race must not retry blindly: its
					// replacement was built over a wrap that no longer exists.
					if (updated.rowCount !== 1) {
						return new Response("Conflict", { status: 409 });
					}
					return { formatVersion: parsed.formatVersion };
				});
			}),
		)
		.post(
			"/api/e2e/identity/rotate",
			guards.guardedPost(async (request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });

				let parsed: z.infer<typeof rotateBody>;
				try {
					parsed = rotateBody.parse(await request.json());
				} catch {
					return new Response("Bad Request", { status: 400 });
				}

				const userId = session.user.id;
				// withUserContext is already one transaction, which is what makes
				// the retire, the insert and the wrap moves atomic without this
				// route arranging anything.
				return await withUserContext(pool, userId, async (client) => {
					const result = await rotateIdentity(client, userId, parsed);
					if (!result.ok) {
						const status = ROTATION_STATUS[result.reason];
						return new Response(status === 409 ? "Conflict" : "Bad Request", {
							status,
						});
					}
					return { publicKey: result.publicKey, rewrapped: result.rewrapped };
				});
			}),
		)
		.get(
			"/api/e2e/provision/pending",
			guards.guardedGet(async (_request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				return await withUserContext(pool, session.user.id, async (client) => ({
					workspaces: await pendingProvisions(client, session.user.id),
				}));
			}),
		)
		.post(
			"/api/e2e/provision",
			guards.guardedPost(async (request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });

				let parsed: z.infer<typeof provisionBody>;
				try {
					parsed = provisionBody.parse(await request.json());
				} catch {
					return new Response("Bad Request", { status: 400 });
				}

				const userId = session.user.id;
				return await withUserContext(pool, userId, async (client) => {
					const result = await provisionWorkspace(client, userId, parsed);
					if (!result.ok) {
						const status = PROVISION_STATUS[result.reason];
						return new Response(status === 403 ? "Forbidden" : "Conflict", {
							status,
						});
					}
					return {
						workspaceId: result.workspaceId,
						version: result.version,
						outcome: result.outcome,
					};
				});
			}),
		)
		.get(
			"/api/e2e/keys/mine",
			guards.guardedGet(async (_request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				return await withUserContext(pool, session.user.id, async (client) => ({
					keys: await myWorkspaceKeys(client, session.user.id),
				}));
			}),
		)
		.get(
			"/api/e2e/grants/pending",
			guards.guardedGet(async (_request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				return await withUserContext(pool, session.user.id, async (client) => ({
					requests: await pendingGrants(client, session.user.id),
				}));
			}),
		)
		.post(
			"/api/e2e/grants/request",
			guards.guardedPost(async (request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				let parsed: z.infer<typeof requestGrantBody>;
				try {
					parsed = requestGrantBody.parse(await request.json());
				} catch {
					return new Response("Bad Request", { status: 400 });
				}
				const result = await withUserContext(
					pool,
					session.user.id,
					async (client) =>
						await requestWorkspaceKey(
							client,
							session.user.id,
							parsed.workspaceId,
						),
				);
				if (!result) return new Response("Not Found", { status: 404 });
				if (result.state === "pending") {
					await notifyGrantCapable(database, result.requestId).catch(
						(error: unknown) => {
							console.error("e2e: grant notification failed:", error);
						},
					);
				}
				return result;
			}),
		)
		.get(
			"/api/e2e/grants/mine",
			guards.guardedGet(async (_request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });
				return await withUserContext(pool, session.user.id, async (client) => ({
					requests: await myGrants(client, session.user.id),
				}));
			}),
		)
		.post(
			"/api/e2e/grants",
			guards.guardedPost(async (request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });

				let parsed: z.infer<typeof grantBody>;
				try {
					parsed = grantBody.parse(await request.json());
				} catch {
					return new Response("Bad Request", { status: 400 });
				}

				const userId = session.user.id;
				return await withUserContext(pool, userId, async (client) => {
					const result = await submitGrant(client, userId, parsed);
					if (!result.ok) {
						return new Response(result.reason, {
							status: GRANT_STATUS[result.reason],
						});
					}
					return { requestId: result.requestId, outcome: result.outcome };
				});
			}),
		)
		.post(
			"/api/e2e/grants/fail",
			guards.guardedPost(async (request, session) => {
				if (!e2eEnabled()) return new Response("Not Found", { status: 404 });

				let parsed: z.infer<typeof grantFailBody>;
				try {
					parsed = grantFailBody.parse(await request.json());
				} catch {
					return new Response("Bad Request", { status: 400 });
				}

				const userId = session.user.id;
				return await withUserContext(pool, userId, async (client) => {
					const marked = await markGrantFailed(
						client,
						userId,
						parsed.requestId,
						parsed.reason,
					);
					if (!marked) return new Response("Not Found", { status: 404 });
					return { requestId: parsed.requestId, state: "failed" };
				});
			}),
		);
}
