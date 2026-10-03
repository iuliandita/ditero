import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { hashImportValue } from "../import-digest.ts";
import { buildImportPlan } from "../import-plan.ts";
import {
	CSV_V1_EXCLUSIONS,
	PROVIDER_INPUT_MAX_BYTES,
	ProviderInputError,
	parseProviderBinding,
	parseProviderInput,
	prepareProviderImport,
	providerDocumentDigest,
} from "./input.ts";

const namespace = "fcb28f31-12ae-4c9d-82f2-1289d9fcb411";
const otherNamespace = "73994b96-f20b-45bd-8808-379810a32ced";
const exportedAt = "2026-01-15T12:00:00.000Z";
const fixture = readFileSync(
	new URL(
		"../../../../tests/fixtures/portability/providers/csv-v1.csv",
		import.meta.url,
	),
);
function input(bytes: Uint8Array = fixture) {
	return {
		kind: "provider",
		version: 1,
		adapter: "ditero-csv",
		adapterVersion: 1,
		sourceNamespace: namespace,
		identityMode: "stable-ids",
		exclusions: [...CSV_V1_EXCLUSIONS],
		originalCsvBase64: Buffer.from(bytes).toString("base64"),
	};
}
function refusal(value: unknown, code = "invalid-input") {
	expect(() => parseProviderInput(value)).toThrowError(
		expect.objectContaining({ name: "ProviderInputError", code }),
	);
}

describe("provider original-input contract", () => {
	test("derives migration content and binding only from the original CSV", () => {
		const prepared = prepareProviderImport(input(), { exportedAt });
		expect(prepared.binding).toEqual({
			kind: "provider",
			version: 1,
			adapter: "ditero-csv",
			adapterVersion: 1,
			sourceNamespace: namespace,
			identityMode: "stable-ids",
			exclusions: CSV_V1_EXCLUSIONS,
		});
		expect(prepared.sourceFormat).toBe("ditero-csv");
		expect(prepared.sourceSchemaVersion).toBe(1);
		expect(prepared.originalBytes).toBe(fixture.length);
		expect(prepared.conversion.document.sourceUserId).toBe(
			`migration:ditero-csv:1:${namespace}:owner`,
		);
		expect(prepared.conversion.findings).toEqual([
			{ code: "untrusted-migration-owner", path: "sourceUserId" },
		]);
		expect(prepared.conversion.document.data.tasks).toHaveLength(2);
		expect(prepared.conversion.document.data.assignments).toEqual([]);
	});

	test.each([
		{ version: 2 },
		{ adapter: "todoist" },
		{ adapterVersion: 2 },
		{ identityMode: "snapshot" },
		{ sourceNamespace: namespace.toUpperCase() },
		{ sourceNamespace: "not-a-uuid" },
		{ document: "{}" },
		{ sourceUserId: "authenticated-user" },
		{ exclusions: [] },
		{ exclusions: [...CSV_V1_EXCLUSIONS].reverse() },
		{ exclusions: [...CSV_V1_EXCLUSIONS, "extra"] },
	])("refuses unknown or changed contract metadata %j", (change) =>
		refusal({ ...input(), ...change }));

	test("refuses missing fields and raw prototype keys before normalization", () => {
		const { adapter: _adapter, ...missing } = input();
		refusal(missing);
		refusal(
			JSON.parse(
				JSON.stringify(input()).replace('"kind":', '"__proto__":{},"kind":'),
			),
		);
		refusal({ ...input(), constructor: "private" });
		refusal(Object.assign(Object.create({ inherited: true }), input()));
		const accessor = input();
		Object.defineProperty(accessor, "adapter", {
			get: () => {
				throw new Error("must not run");
			},
		});
		refusal(accessor);
		refusal({ ...input(), [Symbol("extra")]: true });
	});

	test.each([
		"Zg",
		"Zh==",
		"Zg===",
		"Zg==\n",
		"_w==",
		"Zg==Zg==",
		"!AAA",
		"",
		"====",
	])("refuses noncanonical base64 %j", (value) =>
		refusal({ ...input(), originalCsvBase64: value }, "invalid-base64"));

	test("decodes canonical base64 across chunk boundaries", () => {
		const notes = "a".repeat(25_000);
		const bytes = new TextEncoder().encode(
			new TextDecoder()
				.decode(fixture)
				.replace("Bring bags, and check the pantry", notes)
				.replace("Buy apples,,", `Buy apples,${notes},`),
		);
		expect(input(bytes).originalCsvBase64.length).toBeGreaterThan(65_536);
		const prepared = prepareProviderImport(input(bytes), { exportedAt });
		expect(
			prepared.conversion.document.data.tasks.some(
				(task) => task.notes === notes,
			),
		).toBe(true);
	});

	test("rejects encoded byte excess before decoding or CSV processing", () => {
		refusal(
			{
				...input(),
				originalCsvBase64: "A".repeat(
					4 * Math.ceil((PROVIDER_INPUT_MAX_BYTES + 3) / 3),
				),
			},
			"byte-limit",
		);
		const exact = parseProviderInput(
			input(new Uint8Array(PROVIDER_INPUT_MAX_BYTES)),
		);
		expect(exact.originalCsvBase64.length).toBe(
			4 * Math.ceil(PROVIDER_INPUT_MAX_BYTES / 3),
		);
		refusal(input(new Uint8Array(PROVIDER_INPUT_MAX_BYTES + 1)), "byte-limit");
	});

	test("does not trust metadata that disagrees with the original CSV", () => {
		expect(() =>
			prepareProviderImport(
				{ ...input(), sourceNamespace: otherNamespace },
				{ exportedAt },
			),
		).toThrowError(expect.objectContaining({ code: "metadata-mismatch" }));
	});

	test("rejects invalid UTF-8 and unsupported CSV content without leaking cells", () => {
		expect(() =>
			prepareProviderImport(input(new Uint8Array([0xff])), { exportedAt }),
		).toThrowError(expect.objectContaining({ code: "invalid-encoding" }));
		const secret = "private-provider-cell";
		const bytes = new TextEncoder().encode(
			new TextDecoder().decode(fixture).replace("csv_version,", `${secret},`),
		);
		try {
			prepareProviderImport(input(bytes), { exportedAt });
			throw new Error("accepted");
		} catch (error) {
			expect(String(error)).not.toContain(secret);
			expect(error).toMatchObject({ code: "invalid-csv" });
		}
	});

	test("preserves cancellation and deadlines before conversion", () => {
		const controller = new AbortController();
		controller.abort();
		expect(() =>
			prepareProviderImport(input(), { exportedAt, signal: controller.signal }),
		).toThrowError("cancelled");
		expect(() =>
			prepareProviderImport(input(), {
				exportedAt,
				deadline: performance.now() - 1,
			}),
		).toThrowError("timeout");
	});

	test("shares the absolute deadline across input decoding and CSV validation", () => {
		const envelope = input();
		let now = 0;
		let atobCalls = 0;
		let postDeadlineValidations = 0;
		const decode = TextDecoder.prototype.decode;
		const encode = TextEncoder.prototype.encode;
		const originalAtob = globalThis.atob;
		try {
			vi.spyOn(performance, "now").mockImplementation(() => now);
			vi.spyOn(globalThis, "atob").mockImplementation((value) => {
				const result = originalAtob(value);
				atobCalls++;
				now = 14_000;
				return result;
			});
			vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (
				this: TextDecoder,
				...args: Parameters<TextDecoder["decode"]>
			) {
				const result = decode.apply(this, args);
				now = 16_000;
				return result;
			});
			vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(function (
				this: TextEncoder,
				value?: string,
			) {
				if (now >= 15_000 && value === "Prepare groceries")
					postDeadlineValidations++;
				return encode.call(this, value);
			});
			expect(() =>
				prepareProviderImport(envelope, { exportedAt }),
			).toThrowError("timeout");
			expect(atobCalls).toBe(2);
			expect(postDeadlineValidations).toBe(0);
		} finally {
			vi.restoreAllMocks();
		}
	});

	test("validates stored bindings independently and rejects envelope fields", () => {
		const binding = prepareProviderImport(input(), { exportedAt }).binding;
		expect(parseProviderBinding(binding)).toEqual(binding);
		expect(() =>
			parseProviderBinding({ ...binding, originalCsvBase64: "Zg==" }),
		).toThrow(ProviderInputError);
		expect(() => parseProviderBinding({ ...binding, exclusions: [] })).toThrow(
			ProviderInputError,
		);
	});
});

describe("provider semantic document digest", () => {
	test("wraps the existing native digest and commits the exact binding", async () => {
		const { binding, conversion } = prepareProviderImport(input(), {
			exportedAt,
		});
		const plan = await buildImportPlan(conversion.document, {
			ownerUserId: "caller",
			sourceId: "saved-source",
			mappings: {
				workspaces: {
					[conversion.document.data.workspaces[0]?.id ?? ""]:
						"target-workspace",
				},
				principals: { [conversion.document.sourceUserId]: "caller" },
			},
		});
		const digest = await providerDocumentDigest(binding, plan.documentDigest);
		expect(digest).toBe(
			await hashImportValue(
				"ditero-import-provider-document-v1",
				{ binding, ordinaryDocumentDigest: plan.documentDigest },
				() => {},
			),
		);
		expect(digest).not.toBe(plan.documentDigest);
		expect(
			await providerDocumentDigest(
				{ ...binding, sourceNamespace: otherNamespace },
				plan.documentDigest,
			),
		).not.toBe(digest);
		expect(await providerDocumentDigest(binding, "a".repeat(64))).not.toBe(
			digest,
		);
		await expect(
			providerDocumentDigest(binding, "invalid"),
		).rejects.toMatchObject({ code: "invalid-digest" });
	});

	test("retains semantic equality across row reorder and export times", async () => {
		const lines = new TextDecoder().decode(fixture).trimEnd().split("\n");
		const reordered = new TextEncoder().encode(
			`${[lines[0], ...lines.slice(1).reverse()].join("\n")}\n`,
		);
		async function digest(bytes: Uint8Array, time: string) {
			const { binding, conversion } = prepareProviderImport(input(bytes), {
				exportedAt: time,
			});
			const plan = await buildImportPlan(conversion.document, {
				ownerUserId: "caller",
				sourceId: "source",
				mappings: {
					workspaces: {
						[conversion.document.data.workspaces[0]?.id ?? ""]: "workspace",
					},
					principals: { [conversion.document.sourceUserId]: "caller" },
				},
			});
			return providerDocumentDigest(binding, plan.documentDigest);
		}
		expect(await digest(fixture, exportedAt)).toBe(
			await digest(reordered, "2026-02-01T00:00:00.000Z"),
		);
	});
});
