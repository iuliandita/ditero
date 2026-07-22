// Channel CRUD + test-send. The config column never syncs and never leaves the
// server in cleartext: reads hand back maskChannelConfig output, writes restore
// the MASKED placeholder from the caller's own stored row, and the secret half
// is enveloped at rest (security/channel-config.ts).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { notifyAllowedPrivateCIDRs } from "../../config/notify-egress.ts";
import { workerTiming } from "../../config/worker.ts";
import * as tables from "../../db/schema.ts";
import type { ChannelKind } from "../../domain/notification-channel.ts";
import {
	channelConfigSchema,
	maskChannelConfig,
	restoreChannelConfig,
} from "../../domain/notification-channel.ts";
import {
	channelKeyRing,
	decryptChannelConfig,
	encryptChannelConfig,
} from "../../security/channel-config.ts";
import type { safeFetch } from "../../security/safe-http.ts";
import { ntfyAdapter } from "./adapters/ntfy.ts";
import type { ChannelAdapter } from "./adapters/types.ts";

type Database = NodePgDatabase<typeof tables>;

// M3a ships ntfy only; the other four rows are rendered disabled in the UI
// (shell doc 1) and are rejected here so a hand-rolled POST cannot store a
// config for a channel with no adapter.
const IMPLEMENTED: Partial<Record<ChannelKind, ChannelAdapter>> = {
	ntfy: ntfyAdapter,
};

const CHANNEL_KINDS = new Set<string>(tables.channelKindEnum.enumValues);

// Bounds the client-controlled JSONB, mirroring the M1b/M1c input-cap posture.
const MAX_FIELDS = 20;
const MAX_VALUE_LENGTH = 2_048;

export class ChannelError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

// A closed set of user-safe categories. Never a passthrough of the provider
// response or of delivery_attempt.error, both of which can carry the channel
// URL or the token (shell doc 1).
export type TestFailure =
	| "Could not reach the server"
	| "Server rejected the request"
	| "Request timed out";

export type ChannelView = {
	kind: ChannelKind;
	enabled: boolean;
	verifiedAt: number | null;
	config: Record<string, unknown>;
};

export type ChannelDeps = {
	adapters?: Partial<Record<ChannelKind, ChannelAdapter>>;
	fetch?: typeof safeFetch;
	env?: NodeJS.ProcessEnv;
};

function requireKind(value: unknown): ChannelKind {
	if (typeof value !== "string" || !CHANNEL_KINDS.has(value)) {
		throw new ChannelError("unknown channel kind", 400);
	}
	if (!IMPLEMENTED[value as ChannelKind]) {
		throw new ChannelError("channel not available yet", 400);
	}
	return value as ChannelKind;
}

function requireConfig(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ChannelError("config must be an object", 400);
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > MAX_FIELDS) {
		throw new ChannelError("config has too many fields", 400);
	}
	for (const [, field] of entries) {
		if (typeof field === "string" && field.length > MAX_VALUE_LENGTH) {
			throw new ChannelError("config field is too long", 400);
		}
	}
	return Object.fromEntries(entries);
}

async function storedConfig(
	database: Database,
	userId: string,
	kind: ChannelKind,
	env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown> | null> {
	const rows = await database
		.select({ config: tables.notificationChannel.config })
		.from(tables.notificationChannel)
		.where(
			and(
				eq(tables.notificationChannel.userId, userId),
				eq(tables.notificationChannel.kind, kind),
			),
		)
		.limit(1);
	if (rows.length === 0) return null;
	return decryptChannelConfig(
		kind,
		rows[0].config as Record<string, unknown>,
		channelKeyRing(env),
	);
}

export async function listChannels(
	database: Database,
	userId: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ChannelView[]> {
	const rows = await database
		.select()
		.from(tables.notificationChannel)
		.where(eq(tables.notificationChannel.userId, userId));
	const ring = channelKeyRing(env);
	return rows.map((row) => ({
		kind: row.kind,
		enabled: row.enabled,
		verifiedAt: row.verifiedAt?.getTime() ?? null,
		config: maskChannelConfig(
			row.kind,
			decryptChannelConfig(
				row.kind,
				row.config as Record<string, unknown>,
				ring,
			),
		),
	}));
}

// Returns the effective (decrypted) config alongside the stored view, so
// test-send can send what it just persisted without a second read.
async function upsertChannel(
	database: Database,
	userId: string,
	body: unknown,
	env: NodeJS.ProcessEnv,
): Promise<{ view: ChannelView; config: Record<string, unknown> }> {
	const input = requireConfig(body);
	const kind = requireKind(input.kind);
	const enabled = input.enabled === undefined ? true : input.enabled === true;
	const incoming = requireConfig(input.config);

	const previous = await storedConfig(database, userId, kind, env);
	// Restore BEFORE validation: the schema rejects the literal MASKED value.
	const restored = restoreChannelConfig(
		kind,
		incoming,
		previous ? { kind, config: previous } : null,
	);
	const parsed = channelConfigSchema[kind].safeParse(restored);
	if (!parsed.success) {
		throw new ChannelError("invalid channel config", 400);
	}
	const config = parsed.data as Record<string, unknown>;
	const stored = encryptChannelConfig(kind, config, channelKeyRing(env));
	// A changed config invalidates the previous verification: the old
	// verified_at described a server/topic/token combination that no longer
	// exists.
	const changed =
		previous === null || JSON.stringify(previous) !== JSON.stringify(config);

	const [row] = await database
		.insert(tables.notificationChannel)
		.values({ id: randomUUID(), userId, kind, config: stored, enabled })
		.onConflictDoUpdate({
			target: [
				tables.notificationChannel.userId,
				tables.notificationChannel.kind,
			],
			set: {
				config: stored,
				enabled,
				updatedAt: new Date(),
				...(changed ? { verifiedAt: null } : {}),
			},
		})
		.returning();

	return {
		view: {
			kind: row.kind,
			enabled: row.enabled,
			verifiedAt: row.verifiedAt?.getTime() ?? null,
			config: maskChannelConfig(kind, config),
		},
		config,
	};
}

export async function saveChannel(
	database: Database,
	userId: string,
	body: unknown,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ChannelView> {
	return (await upsertChannel(database, userId, body, env)).view;
}

export async function deleteChannel(
	database: Database,
	userId: string,
	body: unknown,
): Promise<{ deleted: boolean }> {
	const kind = requireKind(requireConfig(body).kind);
	const removed = await database
		.delete(tables.notificationChannel)
		.where(
			and(
				eq(tables.notificationChannel.userId, userId),
				eq(tables.notificationChannel.kind, kind),
			),
		)
		.returning({ id: tables.notificationChannel.id });
	return { deleted: removed.length > 0 };
}

function classify(result: {
	ok: boolean;
	status?: number;
	error?: string;
}): TestFailure {
	if (result.status !== undefined) return "Server rejected the request";
	if (result.error && /abort|timed? ?out/i.test(result.error)) {
		return "Request timed out";
	}
	return "Could not reach the server";
}

// Persists first, then sends: verified_at describes the STORED config, so
// marking a config verified that was never stored would let the settings page
// claim a green check for something the scheduler will never use. The form's
// unsaved edit is still what gets tested (shell doc 1) -- saving it is what
// makes that honest.
export async function testChannel(
	database: Database,
	userId: string,
	body: unknown,
	deps: ChannelDeps = {},
): Promise<
	{ ok: true; verifiedAt: number } | { ok: false; reason: TestFailure }
> {
	const env = deps.env ?? process.env;
	const { view, config } = await upsertChannel(database, userId, body, env);
	const adapter = (deps.adapters ?? IMPLEMENTED)[view.kind];
	if (!adapter) throw new ChannelError("channel not available yet", 400);

	const timing = workerTiming(env);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timing.adapterDeadlineMs);
	let result: { ok: boolean; status?: number; error?: string };
	try {
		result = await adapter.send(
			config,
			{
				title: "Ditero test",
				body: "Test notification from Ditero.",
				urgent: false,
				ackUrl: null,
			},
			{
				allowedPrivateCIDRs: notifyAllowedPrivateCIDRs(
					env.DITERO_NOTIFY_ALLOWED_PRIVATE_CIDRS,
				),
				deadlineMs: timing.adapterDeadlineMs,
				signal: controller.signal,
				fetch: deps.fetch,
			},
		);
	} finally {
		clearTimeout(timer);
	}

	if (!result.ok) return { ok: false, reason: classify(result) };

	const verifiedAt = new Date();
	await database
		.update(tables.notificationChannel)
		.set({ verifiedAt })
		.where(
			and(
				eq(tables.notificationChannel.userId, userId),
				eq(tables.notificationChannel.kind, view.kind),
			),
		);
	return { ok: true, verifiedAt: verifiedAt.getTime() };
}
