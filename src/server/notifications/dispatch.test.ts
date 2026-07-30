// Every notification body is rendered in the recipient's language, and the
// locale reaches the render EXPLICITLY. Paraglide's ambient getLocale is
// process-global, so a server that read it would hand one request's language to
// another's notification.
//
// Only en.json exists today, so every locale still resolves to the same English
// string: asserting on rendered text would pass even if the locale were dropped.
// The messages module is stubbed instead, and what is asserted is the locale
// argument that was actually threaded through.
import { beforeEach, describe, expect, it, vi } from "vitest";

const seen: (string | undefined)[] = [];

vi.mock("../../paraglide/messages.js", () => {
	const record = (
		tag: string,
		options: { locale?: string } | undefined,
		suffix = "",
	) => {
		seen.push(options?.locale);
		return `${tag}:${options?.locale}${suffix}`;
	};
	return {
		m: {
			notify_reminder_body: (
				inputs: { when: string },
				options?: { locale?: string },
			) => record("reminder", options, `:${inputs.when}`),
			notify_assign_body: (_i: unknown, options?: { locale?: string }) =>
				record("assign", options),
			notify_mention_body: (_i: unknown, options?: { locale?: string }) =>
				record("mention", options),
			notify_overdue_body: (_i: unknown, options?: { locale?: string }) =>
				record("overdue", options),
			notify_overdue_body_due: (
				inputs: { due: string },
				options?: { locale?: string },
			) => record("overdue_due", options, `:${inputs.due}`),
		},
	};
});

const { renderPayload } = await import("./dispatch.ts");

const reminder = (locale?: unknown) => ({
	kind: "reminder",
	taskId: "t1",
	taskTitle: "Walk the dog",
	listId: "l1",
	occurrenceAt: "2026-08-01T09:00:00.000Z",
	fireCount: 1,
	urgent: false,
	...(locale === undefined ? {} : { locale }),
});

describe("renderPayload locale threading", () => {
	// Per test, so every assertion below reads only its own renders: a file-scoped
	// accumulator makes the sweep at the bottom depend on execution order.
	beforeEach(() => {
		seen.length = 0;
	});

	it("renders a reminder in the recipient's stored locale", () => {
		const rendered = renderPayload(reminder("de"));
		expect(rendered?.body).toBe("reminder:de:2026-08-01T09:00:00.000Z");
		expect(seen.at(-1)).toBe("de");
	});

	it.each([
		"assign",
		"mention",
		"overdue",
	] as const)("renders a %s event in the recipient's stored locale", (kind) => {
		const rendered = renderPayload({
			kind,
			taskId: "t1",
			taskTitle: "Walk the dog",
			locale: "ar",
		});
		expect(rendered?.body).toBe(`${kind}:ar`);
		expect(seen.at(-1)).toBe("ar");
	});

	it("renders an overdue event carrying a due date in the stored locale", () => {
		const rendered = renderPayload({
			kind: "overdue",
			taskId: "t1",
			taskTitle: "Walk the dog",
			dueAt: "2026-08-01T09:00:00.000Z",
			locale: "fr",
		});
		expect(rendered?.body).toBe("overdue_due:fr:2026-08-01T09:00:00.000Z");
		expect(seen.at(-1)).toBe("fr");
	});

	// Rows enqueued before the payload carried a locale, and anything an operator
	// or a future writer puts in the column, land on en rather than on ambient.
	it.each([
		["no locale", undefined],
		["an unsupported locale", "kl"],
		["a non-string locale", 7],
		["a null locale", null],
	])("falls back to en for %s", (_label, locale) => {
		const rendered = renderPayload(reminder(locale));
		expect(rendered?.body).toBe("reminder:en:2026-08-01T09:00:00.000Z");
		expect(seen.at(-1)).toBe("en");
	});

	// The adapters render the ack button themselves, so the resolved locale has
	// to reach them on the payload, not just the already-rendered body.
	it.each([
		["a reminder", () => reminder("ro")],
		[
			"an event",
			() => ({ kind: "assign", taskId: "t1", taskTitle: "x", locale: "ro" }),
		],
	])("carries the resolved locale onto %s payload", (_label, build) => {
		expect(renderPayload(build())?.locale).toBe("ro");
	});

	it("carries the en fallback onto the payload too", () => {
		expect(renderPayload(reminder("kl"))?.locale).toBe("en");
	});

	// An undefined `locale` option is exactly what sends Paraglide to its ambient
	// getLocale, which is process-global and shared by concurrent sends.
	it("never leaves the locale for the ambient runtime to resolve", () => {
		renderPayload(reminder("es"));
		renderPayload({ kind: "assign", taskId: "t1", taskTitle: "x" });
		renderPayload({ kind: "mention", taskId: "t1", taskTitle: "x" });
		renderPayload({ kind: "overdue", taskId: "t1", taskTitle: "x" });
		renderPayload({
			kind: "overdue",
			taskId: "t1",
			taskTitle: "x",
			dueAt: "2026-08-01T09:00:00.000Z",
		});
		expect(seen).toHaveLength(5);
		expect(seen).not.toContain(undefined);
	});
});
