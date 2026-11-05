import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncPhase } from "../../lib/sync-status.ts";

const status = vi.hoisted(() => ({
	phase: "synced" as SyncPhase,
	pending: 0,
}));

vi.mock("../../hooks/useSyncStatus.ts", () => ({
	useSyncStatus: () => ({
		...status,
		sessionExpired: false,
		dismissRejection: () => {},
	}),
}));
vi.mock("../../lib/zero.tsx", () => ({ useSyncEndpoint: () => null }));

const { SyncNotice } = await import("./SyncNotice.tsx");

const URGENT: SyncPhase[] = [
	"storage-offline",
	"storage-reauth",
	"storage-failed",
];
const QUIET: SyncPhase[] = [
	"synced",
	"syncing",
	"offline",
	"reauth",
	"auth-rejected",
	"stopped",
	"rejected",
];

describe("SyncNotice", () => {
	beforeEach(() => {
		status.pending = 0;
	});

	it.each(
		URGENT,
	)("shows for %s with the existing instruction and Details", (phase) => {
		status.phase = phase;
		const html = renderToStaticMarkup(<SyncNotice />);
		expect(html).toContain('data-testid="sync-notice"');
		expect(html).toMatch(/keep this app open/i);
		expect(html).toContain('data-testid="sync-notice-details"');
		expect(html).not.toMatch(/reload|sign in again/i);
	});

	it.each(QUIET)("stays out of the way for %s", (phase) => {
		status.phase = phase;
		expect(renderToStaticMarkup(<SyncNotice />)).toBe("");
	});

	it("reports the pending count only when there is one", () => {
		status.phase = "storage-failed";
		expect(renderToStaticMarkup(<SyncNotice />)).not.toContain(
			"sync-notice-pending",
		);
		status.pending = 2;
		expect(renderToStaticMarkup(<SyncNotice />)).toContain(
			"2 recent changes not synced yet",
		);
	});
});
