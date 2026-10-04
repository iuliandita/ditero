import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { renderFrame } from "./render.ts";
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

async function paintInPty(
	text: string,
	columns: number,
	rows: number,
): Promise<string> {
	const child = `import { createTerminalSession } from ${JSON.stringify(new URL("./terminal.ts", import.meta.url).pathname)};
const session = createTerminalSession({onKey() {}, onResize() {}, onExit() {}});
session.paint(${JSON.stringify(text)}); session.close(); process.exit(0);`;
	const code = `let output = "";
const terminal = new Bun.Terminal({cols: ${columns}, rows: ${rows}, data(_terminal, bytes) { output += new TextDecoder().decode(bytes); }});
const proc = Bun.spawn([process.execPath, "-e", ${JSON.stringify(child)}], {terminal, env: {...process.env, TERM: "xterm-256color"}});
const timeout = setTimeout(() => proc.kill("SIGKILL"), 5000);
try { const exit = await proc.exited; await Bun.sleep(20); if(exit !== 0) throw new Error("Paint child failed"); process.stdout.write(JSON.stringify(output)); }
finally { clearTimeout(timeout); if(proc.exitCode === null) {proc.kill("SIGKILL"); await proc.exited;} terminal.close(); }`;
	const { stdout } = await execute("bun", ["-e", code], {
		timeout: 8000,
		maxBuffer: 1024 * 1024,
	});
	const output = JSON.parse(stdout) as string;
	return output
		.split("\u001b[H\u001b[2J")[1]
		.split("\u001b[?2004l")[0]
		.replace(/\r/gu, "");
}

describe("actual terminal painting bounds", () => {
	it("clips grapheme cells, resets styles and refuses hostile controls in the actual paint path", async () => {
		const output = await paintInPty(
			"\u001b[31;7m猫🙂e\u0301tail\u001b[0m\nplain     x\n\u001b[38;2;1;2;3mX\u001b[2J\u009b\u202e",
			5,
			3,
		);
		expect(output.split("\n")[0]).toBe("\u001b[31;7m猫🙂e\u0301\u001b[0m");
		expect(output.split("\n")[1]).toBe("plain");
		expect(output).not.toContain("\u001b[38;");
		expect(output).not.toContain("\u001b[2J");
		expect(output).not.toContain("\u009b");
		expect(output).not.toContain("\u202e");
	});
	it("retains only the fixed bold and dim forms through actual paint", async () => {
		const input =
			"\u001b[36;7;1mHigh 猫🙂\u001b[0m\n\u001b[2mDone\u001b[0m\n\u001b[33;1mNOT SENT\u001b[0m\n\u001b[1;7;31mno\u001b[5mblink\u001b[0m";
		const output = await paintInPty(input, 10, 4);
		expect(output).toContain("\u001b[36;7;1mHigh 猫🙂\u001b[0m");
		expect(output).toContain("\u001b[2mDone\u001b[0m");
		expect(output).toContain("\u001b[33;1mNOT SENT\u001b[0m");
		expect(output).not.toContain("\u001b[1;7;31m");
		expect(output).not.toContain("\u001b[5m");
	});

	it("preserves plain layout padding without adding color to monochrome output", async () => {
		expect(await paintInPty("A   Bextra\n○ Done", 5, 2)).toBe("A   B\n○ Don");
	});

	it("retains the full colored layout and metadata through the final PTY clamp", async () => {
		const frame = {
			title: "Ditero Tasks",
			status: "Ready",
			statusLine: "Page 1 | Loaded: 1",
			footer: "q quit",
			rows: ["Milk"],
			selected: 0,
			framed: true,
			rowParts: [
				[
					{ text: "○ ", tone: "plain" as const },
					{ text: "High ", tone: "danger" as const },
					{ text: "Milk", tone: "plain" as const },
				],
			],
			rowMetadataParts: [
				[
					{ text: "Overdue: Oct 3, 2026", tone: "danger" as const },
					{ text: "2 bags", tone: "plain" as const },
					{ text: "@2 #1", tone: "plain" as const },
				],
			],
		};
		const actual = await paintInPty(
			renderFrame({ ...frame, color: true }, 110, 12),
			110,
			12,
		);
		const plain = actual.replace(
			new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"),
			"",
		);
		expect(plain).toBe(renderFrame(frame, 110, 12));
		expect(plain).toContain("@2 #1");
		expect(plain.split("\n")[3]).toMatch(/│$/u);
	}, 10000);
});
