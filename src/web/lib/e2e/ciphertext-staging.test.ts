import { afterEach, describe, expect, test, vi } from "vitest";
import {
	recoverCiphertextStages,
	withCiphertextStage,
} from "./ciphertext-staging.ts";

afterEach(() => vi.unstubAllGlobals());

function stageBrowser() {
	const files = new Map<string, { kind: "file" | "directory" }>();
	const held = new Set<string>();
	const createWritable = vi.fn(async () => ({}));
	const root = {
		async *entries() {
			yield* [...files];
		},
		async getFileHandle(name: string) {
			expect(held.has(name)).toBe(true);
			files.set(name, { kind: "file" });
			return { createWritable };
		},
		async removeEntry(name: string) {
			expect(held.has(name)).toBe(true);
			files.delete(name);
		},
	};
	const locks = {
		async request<T>(
			name: string,
			optionsOrUse: LockOptions | ((lock: object | null) => Promise<T>),
			callback?: (lock: object | null) => Promise<T>,
		): Promise<T> {
			const use = typeof optionsOrUse === "function" ? optionsOrUse : callback;
			if (!use) throw new Error("missing lock callback");
			if (held.has(name)) {
				expect(optionsOrUse).toEqual({ ifAvailable: true });
				return await use(null);
			}
			held.add(name);
			try {
				return await use({ name });
			} finally {
				held.delete(name);
			}
		},
	};
	vi.stubGlobal("navigator", {
		locks,
		storage: { getDirectory: async () => root },
	});
	return { files, held, createWritable };
}

describe("upload stage lifecycle", () => {
	test("recovers only its scope while preserving other orphans and held stages", async () => {
		const { files, held } = stageBrowser();
		const ownScope = "https://first.example/u_1";
		const otherScope = `${ownScope}-other`;
		async function stageName(scope?: string): Promise<string> {
			let created: string | undefined;
			await withCiphertextStage(async () => {
				created = [...files.keys()][0];
			}, scope);
			if (!created) throw new Error("stage was not created");
			return created;
		}
		const ownOrphan = await stageName(ownScope);
		const ownActive = await stageName(ownScope);
		const otherOrphan = await stageName(otherScope);
		const browserOrphan = await stageName();
		// Terminated owners release their locks without deleting their files.
		for (const name of [ownOrphan, ownActive, otherOrphan, browserOrphan]) {
			files.set(name, { kind: "file" });
		}
		held.add(ownActive);
		await recoverCiphertextStages(ownScope);
		expect(files.has(ownOrphan)).toBe(false);
		expect([...files.keys()]).toEqual([ownActive, otherOrphan, browserOrphan]);
		expect(held.has(ownActive)).toBe(true);
		held.delete(ownActive);
		await recoverCiphertextStages(ownScope);
		expect([...files.keys()]).toEqual([otherOrphan, browserOrphan]);
		await recoverCiphertextStages();
		expect([...files.keys()]).toEqual([otherOrphan]);
		await recoverCiphertextStages(otherScope);
		expect(files.size).toBe(0);
		for (const scope of ["", " ", "\t"]) {
			await expect(recoverCiphertextStages(scope)).rejects.toThrow(
				"storage scope must be nonempty",
			);
			await expect(
				withCiphertextStage(async () => undefined, scope),
			).rejects.toThrow("storage scope must be nonempty");
		}
	});

	test("removes the stage when acquiring its writable fails", async () => {
		const { files, createWritable } = stageBrowser();
		const failure = new DOMException("quota", "QuotaExceededError");
		createWritable.mockRejectedValueOnce(failure);
		await expect(
			withCiphertextStage(async (handle) => await handle.createWritable()),
		).rejects.toBe(failure);
		expect(files.size).toBe(0);
	});

	test("recovers terminated stages but leaves active tabs and legacy files alone", async () => {
		const { files, held } = stageBrowser();
		files.set("ditero-ciphertext-v1-terminated", { kind: "file" });
		files.set("ditero-ciphertext-v1-other-tab", { kind: "file" });
		files.set("ditero-upload-old-tab", { kind: "file" });
		files.set("unrelated", { kind: "file" });
		files.set("ditero-ciphertext-v1-directory", { kind: "directory" });
		held.add("ditero-ciphertext-v1-other-tab");
		await recoverCiphertextStages();
		expect([...files.keys()]).toEqual([
			"ditero-ciphertext-v1-other-tab",
			"ditero-upload-old-tab",
			"unrelated",
			"ditero-ciphertext-v1-directory",
		]);
		// Browser termination releases the owner's lock without running cleanup.
		held.delete("ditero-ciphertext-v1-other-tab");
		await recoverCiphertextStages();
		expect(files.has("ditero-ciphertext-v1-other-tab")).toBe(false);
	});

	test("keeps the stage locked throughout use and recovers orphans before creating it", async () => {
		const { files } = stageBrowser();
		files.set("ditero-ciphertext-v1-orphan", { kind: "file" });
		await withCiphertextStage(async () => {
			expect(files.has("ditero-ciphertext-v1-orphan")).toBe(false);
			const [activeName] = files.keys();
			await recoverCiphertextStages();
			expect(files.has(activeName)).toBe(true);
			await withCiphertextStage(async () => {
				expect(files.size).toBe(2);
				await recoverCiphertextStages();
				expect(files.size).toBe(2);
			});
			expect(files.size).toBe(1);
		});
		expect(files.size).toBe(0);
	});

	test("does not touch storage without a cross-tab lock manager", async () => {
		const getDirectory = vi.fn();
		vi.stubGlobal("navigator", { storage: { getDirectory } });
		await recoverCiphertextStages();
		expect(getDirectory).not.toHaveBeenCalled();
	});
});
