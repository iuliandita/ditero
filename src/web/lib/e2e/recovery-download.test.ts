import { expect, test, vi } from "vitest";
import { createAttachmentRuntime } from "../../../../apps/android/src/attachment-runtime.ts";
import { NativeError } from "../../../../apps/android/src/bridge.ts";
import { FilePickerCancelledError } from "./download.ts";
import { downloadRecoveryCode } from "./recovery-download.ts";
import type { E2eRuntime } from "./runtime.ts";

function fixture(desktop: boolean, fail?: "save.pick" | "save.write") {
	const call = vi.fn(async (op: string) => {
		if (op === fail)
			throw new NativeError(
				op === "save.pick" ? "cancelled" : "file-write-failed",
			);
		return op === "save.pick" ? { ok: true, saveId: "save-A" } : { ok: true };
	});
	const runtime: E2eRuntime = {
		fetcher: vi.fn(),
		signOut: vi.fn(),
		attachments: createAttachmentRuntime(() => {}, "account-A", desktop, call),
	};
	return { runtime, call };
}

test.each([
	false,
	true,
])("recovery download uses named native saving (desktop=%s)", async (desktop) => {
	const { runtime, call } = fixture(desktop);
	await downloadRecoveryCode(
		"TEST-CODE",
		runtime,
		new AbortController().signal,
	);
	expect(call.mock.calls.map(([op]) => op)).toEqual([
		"save.pick",
		"save.write",
		"save.finish",
	]);
	expect(call).toHaveBeenNthCalledWith(1, "save.pick", {
		filename: "ditero-recovery-code.txt",
	});
	expect(call).toHaveBeenNthCalledWith(2, "save.write", {
		saveId: "save-A",
		seq: 0,
		data: btoa("TEST-CODE"),
	});
});

test.each([
	"save.pick",
	"save.write",
] as const)("recovery download preserves %s failure and cancels unfinished saving", async (failure) => {
	const { runtime, call } = fixture(false, failure);
	const result = downloadRecoveryCode(
		"TEST-CODE",
		runtime,
		new AbortController().signal,
	);
	if (failure === "save.pick")
		await expect(result).rejects.toBeInstanceOf(FilePickerCancelledError);
	else
		await expect(result).rejects.toMatchObject({ code: "file-write-failed" });
	expect(call.mock.calls.some(([op]) => op === "save.finish")).toBe(false);
	expect(
		call.mock.calls.some(
			([op]) =>
				op === (failure === "save.pick" ? "save.cancelPending" : "save.cancel"),
		),
	).toBe(true);
});
