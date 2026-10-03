import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TerminalDecoder, type TerminalInput } from "./terminal";

const encode = (text: string) => new TextEncoder().encode(text);
const execute = promisify(execFile);
const fixture = new URL("../../tests/tui/terminal-pty.ts", import.meta.url)
	.pathname;

describe("TerminalDecoder", () => {
	it("decodes fragmented UTF-8 and CSI, retaining paste newlines as data", () => {
		const events: TerminalInput[] = [];
		const decoder = new TerminalDecoder((event) => events.push(event));
		for (const byte of encode("é\x1b[A\x1b[200~one\ntwo\x1b[201~\r"))
			decoder.feed(Uint8Array.of(byte));
		expect(events).toEqual([
			{ type: "text", text: "é" },
			{ type: "key", key: "up" },
			{ type: "paste", text: "one\ntwo" },
			{ type: "key", key: "enter" },
		]);
	});
	it("discards unknown escapes and reports invalid UTF-8", () => {
		const events: TerminalInput[] = [];
		const decoder = new TerminalDecoder((event) => events.push(event));
		decoder.feed(encode("\x1b[99~\x1bx"));
		decoder.feed(Uint8Array.of(255));
		decoder.feed(encode("\x1b"));
		decoder.flushEscape();
		expect(events).toEqual([
			{ type: "invalid", reason: "invalid-encoding" },
			{ type: "key", key: "escape" },
		]);
	});
	it("bounds paste and pending escape input and recovers after overflow", () => {
		const events: TerminalInput[] = [];
		const decoder = new TerminalDecoder((event) => events.push(event));
		decoder.feed(encode(`\x1b[200~${"a".repeat(70000)}\n\x1b[201~z`));
		decoder.feed(encode(`\x1b[${"1".repeat(70000)}~q`));
		expect(events).toEqual([
			{ type: "invalid", reason: "input-limit" },
			{ type: "text", text: "z" },
			{ type: "invalid", reason: "input-limit" },
			{ type: "text", text: "q" },
		]);
	});
	it("lets Ctrl-C interrupt even inside bracketed paste", () => {
		const events: TerminalInput[] = [];
		const decoder = new TerminalDecoder((event) => events.push(event));
		decoder.feed(encode("\x1b[200~\x03"));
		expect(events).toEqual([{ type: "key", key: "ctrl-c" }]);
	});
	it("discards string escapes through their terminator and recovers malformed UTF-8", () => {
		const events: TerminalInput[] = [];
		const decoder = new TerminalDecoder((event) => events.push(event));
		decoder.feed(encode("\x1b]title\nignored\x07\x1bPignored\r\x1b\\"));
		decoder.feed(Uint8Array.of(195, 120));
		expect(events).toEqual([
			{ type: "invalid", reason: "invalid-encoding" },
			{ type: "text", text: "x" },
		]);
	});
});

describe("real terminal session", () => {
	it.each([
		"close",
		"interrupt",
		"signal",
		"error",
		"paused",
		"raw",
		"startup",
	])("restores the PTY after %s", async (mode) => {
		const { stdout } = await execute("bun", [fixture, mode], {
			timeout: 15000,
			maxBuffer: 1024 * 1024,
		});
		const receipt = JSON.parse(stdout);
		expect(receipt.code).toBe(0);
		expect(receipt.after).toEqual(receipt.before);
		const match = receipt.output.match(/EXIT:(\{[^\r\n]+\})/);
		expect(match).toBeTruthy();
		const exit = JSON.parse(match[1]);
		expect(exit.reason).toBe(
			mode === "paused" || mode === "raw"
				? "close"
				: mode === "startup"
					? "error"
					: mode,
		);
		expect(exit.exits).toBe(1);
		expect(exit.after).toEqual(exit.before);
		if (mode !== "startup") {
			expect(receipt.output).toContain('RESIZE:{"columns":31,"rows":9}');
			expect(receipt.output.split("\x1b[?1049l")).toHaveLength(2);
		} else expect(receipt.output).not.toContain("\x1b");
		if (mode === "close") {
			expect(receipt.output).toContain('"type":"text","text":"é"');
			expect(receipt.output).toContain('"type":"paste","text":"hello\\nworld"');
			expect(receipt.output).toContain('"key":"escape"');
		}
	}, 15000);
	it("refuses non-TTY streams without terminal writes", async () => {
		const { stdout } = await execute("bun", [fixture, "notty"], {
			timeout: 15000,
		});
		expect(stdout).toBe("REFUSED\n");
	});
	it("refuses a dumb PTY without terminal writes", async () => {
		const { stdout } = await execute("bun", [fixture, "dumb-pty"], {
			timeout: 15000,
		});
		const receipt = JSON.parse(stdout);
		expect(receipt.code).toBe(0);
		expect(receipt.output).toBe("REFUSED\r\n");
	}, 15000);
});
