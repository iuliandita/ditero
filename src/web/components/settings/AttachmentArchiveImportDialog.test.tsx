import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import { AttachmentArchiveImportDialog } from "./AttachmentArchiveImportDialog.tsx";

const fixture = vi.hoisted(() => ({
	content: "",
	archive: "",
	passphrase: "",
	busy: false,
	reading: 0,
	strings: 0,
	booleans: 0,
}));
vi.mock("react", async (original) => {
	const react = await original<typeof import("react")>();
	return {
		...react,
		useState: (initial: unknown) => {
			let value = typeof initial === "function" ? initial() : initial;
			if (typeof value === "string")
				value = [fixture.content, fixture.archive, fixture.passphrase][
					fixture.strings++
				];
			if (value === false && ++fixture.booleans === 2) value = fixture.busy;
			if (value === 0) value = fixture.reading;
			return [value, vi.fn()];
		},
	};
});
vi.mock("@rocicorp/zero/react", () => ({
	useZero: () => ({ userID: "owner" }),
	useQuery: () => [[]],
}));
vi.mock("../../../zero/queries.ts", () => ({
	queries: {
		lists: { mine: vi.fn() },
		tasks: { mine: vi.fn() },
		comments: { mine: vi.fn() },
	},
}));
vi.mock("../../lib/e2e/KeyringProvider.tsx", () => ({
	useKeyring: () => ({
		ready: true,
		state: "ready",
		runtime: { attachments: { archiveInput: {}, archiveMigration: {} } },
	}),
}));
vi.mock("../../lib/e2e/attachment-import-controller.ts", () => ({
	createAttachmentImportController: vi.fn(),
}));
vi.mock("../e2e/UnlockDialog.tsx", () => ({ UnlockDialog: () => null }));
vi.mock("../ui/dialog.tsx", () => {
	const Wrapper = ({ children }: { children?: import("react").ReactNode }) => (
		<div>{children}</div>
	);
	return {
		Dialog: Wrapper,
		DialogContent: Wrapper,
		DialogHeader: Wrapper,
		DialogTitle: Wrapper,
		DialogDescription: Wrapper,
	};
});
vi.mock("../../../paraglide/runtime.js", () => ({
	getLocale: () => "en",
	experimentalStaticLocale: undefined,
}));
beforeEach(() =>
	Object.assign(fixture, {
		content: "",
		archive: "",
		passphrase: "",
		busy: false,
		reading: 0,
		strings: 0,
		booleans: 0,
	}),
);
function markup() {
	return renderToStaticMarkup(
		<AttachmentArchiveImportDialog
			binding={{
				ownerId: "owner",
				jobId: "a".repeat(64),
				sourceId: "source",
				documentDigest: "b".repeat(64),
				mappingDigest: "c".repeat(64),
				planDigest: "d".repeat(64),
			}}
			onClose={() => {}}
		/>,
	);
}
test.each([
	["", "", "", "Choose the paired content JSON file."],
	["content", "", "", "Choose the encrypted files archive."],
	["content", "archive", "", "Enter the archive passphrase."],
])("explains missing prerequisite %# beside its disabled action", (content, archive, passphrase, reason) => {
	Object.assign(fixture, { content, archive, passphrase });
	const html = markup();
	const described = html.match(
		/aria-describedby="([^"]+-open-blocked)" disabled=""/,
	);
	expect(described).not.toBeNull();
	expect(html).toContain(`id="${described?.[1]}"`);
	expect(html.match(/<p id="[^"]+-open-blocked"[^>]*>([^<]*)<\/p>/)?.[1]).toBe(
		reason,
	);
});
test.each([
	[false, 1, "Reading selected file..."],
	[true, 1, "Working..."],
])("pending state takes precedence %#", (busy, reading, reason) => {
	Object.assign(fixture, { busy, reading });
	const html = markup();
	expect(html.match(/<p id="[^"]+-open-blocked"[^>]*>([^<]*)<\/p>/)?.[1]).toBe(
		reason,
	);
	expect(html).not.toContain("Choose the paired content JSON file.");
});
test("all prerequisites enable opening without a stale explanation", () => {
	Object.assign(fixture, {
		content: "content",
		archive: "archive",
		passphrase: "secret",
	});
	const html = markup();
	expect(html).not.toContain("-open-blocked");
	const action = html.match(/<button([^>]*)>Open archive<\/button>/);
	expect(action).not.toBeNull();
	expect(action?.[1]).not.toContain(' disabled=""');
	expect(html).toContain("It stays on this device");
});
