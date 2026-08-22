import { beforeEach, describe, expect, it } from "vitest";
import { KdfError } from "../../../domain/e2e/kdf.ts";
import { createDeriver } from "./derive.ts";
import type { KdfRequest, KdfResponse } from "./kdf-protocol.ts";

// A stand-in for the real worker: the point of these tests is the correlation
// and error plumbing between page and worker, not Argon2id, whose output is
// already pinned against RFC vectors in src/domain/e2e/kdf.test.ts.
class FakeWorker implements Pick<Worker, "postMessage" | "terminate"> {
	readonly seen: KdfRequest[] = [];
	terminated = false;
	private listeners = new Map<string, ((event: unknown) => void)[]>();

	addEventListener(type: string, listener: (event: unknown) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	postMessage(request: KdfRequest): void {
		this.seen.push(request);
	}

	terminate(): void {
		this.terminated = true;
	}

	emit(response: KdfResponse): void {
		for (const listener of this.listeners.get("message") ?? []) {
			listener({ data: response } as MessageEvent<KdfResponse>);
		}
	}

	fail(message: string): void {
		for (const listener of this.listeners.get("error") ?? []) {
			listener({ message });
		}
	}
}

let worker: FakeWorker;
let spawns: number;

const deriver = () => {
	spawns = 0;
	return createDeriver(() => {
		spawns += 1;
		worker = new FakeWorker();
		return worker as unknown as Worker;
	});
};

const SALT = new Uint8Array(16).fill(3);

beforeEach(() => {
	spawns = 0;
});

describe("createDeriver", () => {
	it("resolves each caller with its own answer when derivations overlap", async () => {
		const d = deriver();
		const passphrase = d.derive("pass", SALT, "passphrase", 1);
		const recovery = d.derive("code", SALT, "recovery", 1);
		expect(worker.seen.map((r) => r.purpose)).toEqual([
			"passphrase",
			"recovery",
		]);

		// Answered out of order on purpose. An uncorrelated protocol resolves
		// whichever promise is first, handing the recovery KEK to the passphrase
		// wrap -- a wrap that then opens under neither secret, discovered only at
		// unlock, with the passphrase long since forgotten.
		const [first, second] = worker.seen;
		if (!first || !second) throw new Error("both requests must have been sent");
		worker.emit({ id: second.id, kek: new Uint8Array(32).fill(2) });
		worker.emit({ id: first.id, kek: new Uint8Array(32).fill(1) });

		expect(await passphrase).toEqual(new Uint8Array(32).fill(1));
		expect(await recovery).toEqual(new Uint8Array(32).fill(2));
	});

	it("reuses one worker across derivations", async () => {
		const d = deriver();
		const a = d.derive("pass", SALT, "passphrase", 1);
		worker.emit({ id: 0, kek: new Uint8Array(32) });
		await a;
		const b = d.derive("pass", SALT, "passphrase", 1);
		worker.emit({ id: 1, kek: new Uint8Array(32) });
		await b;
		expect(spawns).toBe(1);
	});

	it("rebuilds the KdfError reason that structured clone erased", async () => {
		const d = deriver();
		const pending = d.derive("pass", SALT, "passphrase", 9);
		worker.emit({
			id: 0,
			failure: "unsupported-version",
			message: "kdf: unsupported KDF version 9",
		});
		await expect(pending).rejects.toBeInstanceOf(KdfError);
		await expect(pending).rejects.toMatchObject({
			reason: "unsupported-version",
		});
	});

	it("rejects every waiter when the worker dies", async () => {
		const d = deriver();
		const a = d.derive("pass", SALT, "passphrase", 1);
		const b = d.derive("code", SALT, "recovery", 1);
		worker.fail("boom");
		// Both, not just the first: a surviving promise leaves its dialog on the
		// spinner with nothing left to answer it.
		await expect(a).rejects.toBeInstanceOf(KdfError);
		await expect(b).rejects.toBeInstanceOf(KdfError);
		expect(worker.terminated).toBe(true);
	});

	it("spawns a fresh worker after a crash", async () => {
		const d = deriver();
		const dead = d.derive("pass", SALT, "passphrase", 1);
		worker.fail("boom");
		await expect(dead).rejects.toBeInstanceOf(KdfError);

		const revived = d.derive("pass", SALT, "passphrase", 1);
		worker.emit({ id: 1, kek: new Uint8Array(32).fill(7) });
		expect(await revived).toEqual(new Uint8Array(32).fill(7));
		expect(spawns).toBe(2);
	});

	it("rejects outstanding derivations on dispose", async () => {
		const d = deriver();
		const pending = d.derive("pass", SALT, "passphrase", 1);
		d.dispose();
		await expect(pending).rejects.toBeInstanceOf(KdfError);
		expect(worker.terminated).toBe(true);
	});

	it("never sends the secret until a caller asks for one", () => {
		const d = deriver();
		expect(spawns).toBe(0);
		d.dispose();
	});
});
