import { describe, expect, it } from "vitest";
import { randomId } from "./random-id.ts";

const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// A plain-HTTP origin that is not localhost: getRandomValues exists, randomUUID
// does not. This is the shape of the object, not a mock of a mock.
function insecureContext(fill: (b: Uint8Array) => void = () => {}): Crypto {
	return {
		getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
			if (array instanceof Uint8Array) fill(array);
			return array;
		},
	} as unknown as Crypto;
}

describe("randomId", () => {
	it("uses randomUUID when the context is secure", () => {
		const source = {
			randomUUID: () => "11111111-1111-4111-8111-111111111111",
		} as unknown as Crypto;
		expect(randomId(source)).toBe("11111111-1111-4111-8111-111111111111");
	});

	it("still produces a v4 UUID without randomUUID", () => {
		expect(randomId(insecureContext())).toMatch(UUID_V4);
	});

	it("stamps the version and variant bits rather than echoing the bytes", () => {
		// All-zero entropy: any id that is not the version/variant pattern means
		// the bits were never applied, and ids would collide across clients.
		const id = randomId(insecureContext((b) => b.fill(0)));
		expect(id).toBe("00000000-0000-4000-8000-000000000000");
	});

	it("stamps them over set bits too, not only clear ones", () => {
		const id = randomId(insecureContext((b) => b.fill(0xff)));
		expect(id).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
	});

	it("draws fresh entropy per call", () => {
		let n = 0;
		const source = insecureContext((b) => b.fill(n++));
		expect(randomId(source)).not.toBe(randomId(source));
	});

	it("refuses to invent randomness when the context has none", () => {
		expect(() => randomId({} as Crypto)).toThrow(/random source/);
	});
});
