import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { VoiceState } from "../../../domain/voice-capture.ts";
import type { VoiceView } from "./useVoiceCapture.ts";
import { VoiceCapture } from "./VoiceCapture.tsx";

const noop = () => {};
const view = (state: VoiceState): VoiceView => ({
	state,
	blocking: false,
	blockedNow: () => false,
	cancelIfActive: () => false,
	start: noop,
	acknowledge: noop,
	stop: noop,
	cancel: noop,
	retry: noop,
	retryAfterReview: noop,
	accept: () => null,
});
const render = (state: VoiceState) =>
	renderToStaticMarkup(
		<VoiceCapture voice={view(state)} onUse={noop} onFocusInput={noop} />,
	);
const startButton = (html: string) =>
	html.match(/<button[^>]*data-testid="quickadd-voice-start"[^>]*>/)?.[0] ?? "";

const idle = (vendor: boolean, acknowledged: boolean): VoiceState => ({
	phase: "idle",
	session: 1,
	ready: true,
	vendor,
	acknowledged,
});

test("a vendor-service engine shows the notice and keeps the mic off with a reason", () => {
	const html = render(idle(true, false));
	expect(html).toContain("may send your voice to its vendor");
	expect(html).toContain("Dictation stays off until you accept this.");
	expect(html).toContain('data-testid="quickadd-voice-accept"');
	expect(startButton(html)).toContain('disabled=""');
	expect(html).not.toContain("never uploaded");
});

test("after acceptance the mic is usable and the notice stays visible", () => {
	const html = render(idle(true, true));
	expect(html).toContain("may send your voice to its vendor");
	expect(html).not.toContain("quickadd-voice-accept");
	expect(startButton(html)).not.toContain('disabled=""');
});

test("an on-device engine keeps the on-device privacy line and needs no notice", () => {
	const html = render(idle(false, true));
	expect(html).toContain("never uploaded");
	expect(html).not.toContain("quickadd-voice-accept");
	expect(startButton(html)).not.toContain('disabled=""');
});

test("review names the speech service when the vendor engine produced the text", () => {
	const review = (vendor: boolean) =>
		render({ phase: "review", session: 1, alternatives: ["milk"], vendor });
	expect(review(true)).toContain("Heard by your browser&#x27;s speech service");
	expect(review(false)).toContain("Heard on this device");
});
