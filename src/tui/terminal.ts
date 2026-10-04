import { fitStyledLine } from "./render.ts";

export type TerminalKey =
	| "up"
	| "down"
	| "left"
	| "right"
	| "enter"
	| "escape"
	| "backspace"
	| "home"
	| "end"
	| "tab"
	| "ctrl-c";
export type TerminalInput =
	| { type: "key"; key: TerminalKey }
	| { type: "text"; text: string }
	| { type: "paste"; text: string }
	| { type: "invalid"; reason: "input-limit" | "invalid-encoding" };

const LIMIT = 64 * 1024;
const PASTE_END = [27, 91, 50, 48, 49, 126];
const KEYS: Record<string, TerminalKey> = {
	"[A": "up",
	"[B": "down",
	"[C": "right",
	"[D": "left",
	"[H": "home",
	"[F": "end",
	"[1~": "home",
	"[4~": "end",
	"[7~": "home",
	"[8~": "end",
	OH: "home",
	OF: "end",
};

export class TerminalDecoder {
	private pending: number[] = [];
	private paste: number[] | undefined;
	private pasteTail: number[] = [];
	private discardPaste = false;
	private discardEscape = false;
	private stringEscape = false;
	private stringEscapeBytes = 0;
	private stringEscapePrevious = 0;
	constructor(private readonly emit: (input: TerminalInput) => void) {}
	get awaitingEscape(): boolean {
		return this.pending.length === 1 && this.pending[0] === 27;
	}
	flushEscape(): void {
		if (this.awaitingEscape) {
			this.pending = [];
			this.emit({ type: "key", key: "escape" });
		}
	}
	feed(bytes: Uint8Array): void {
		for (const byte of bytes) {
			if (byte === 3) {
				this.emit({ type: "key", key: "ctrl-c" });
				continue;
			}
			if (this.stringEscape) {
				if (byte === 7 || (this.stringEscapePrevious === 27 && byte === 92)) {
					this.stringEscape = false;
					this.stringEscapeBytes = 0;
				} else {
					if (this.stringEscapeBytes === LIMIT)
						this.emit({ type: "invalid", reason: "input-limit" });
					this.stringEscapeBytes = Math.min(
						LIMIT + 1,
						this.stringEscapeBytes + 1,
					);
				}
				this.stringEscapePrevious = byte;
				continue;
			}
			if (this.paste !== undefined || this.discardPaste) {
				this.pasteTail.push(byte);
				if (this.pasteTail.length > PASTE_END.length) {
					const first = this.pasteTail.shift();
					if (first !== undefined && this.paste) this.paste.push(first);
				}
				if (this.paste && this.paste.length > LIMIT) {
					this.paste = undefined;
					this.discardPaste = true;
					this.emit({ type: "invalid", reason: "input-limit" });
				}
				if (
					this.pasteTail.length === 6 &&
					this.pasteTail.every((value, i) => value === PASTE_END[i])
				) {
					if (this.paste) this.decode(this.paste, "paste");
					this.paste = undefined;
					this.discardPaste = false;
					this.pasteTail = [];
				}
				continue;
			}
			if (this.discardEscape) {
				if (byte >= 64 && byte <= 126) this.discardEscape = false;
				continue;
			}
			this.pending.push(byte);
			if (this.pending[0] === 27) {
				if (this.pending.length === 1) continue;
				const second = this.pending[1];
				if (second === 93 || second === 80 || second === 94 || second === 95) {
					this.pending = [];
					this.stringEscape = true;
					this.stringEscapePrevious = 0;
					continue;
				}
				if (second !== 91 && second !== 79) {
					this.pending = [];
					continue;
				}
				if (this.pending.length > LIMIT) {
					this.pending = [];
					this.discardEscape = true;
					this.emit({ type: "invalid", reason: "input-limit" });
					continue;
				}
				if (this.pending.length < 3 || byte < 64 || byte > 126) continue;
				const sequence = new TextDecoder().decode(
					Uint8Array.from(this.pending.slice(1)),
				);
				this.pending = [];
				if (sequence === "[200~") {
					this.paste = [];
					continue;
				}
				const key = KEYS[sequence];
				if (key) this.emit({ type: "key", key });
				continue;
			}
			const first = this.pending[0] ?? 0;
			if (this.pending.length > 1 && (byte < 128 || byte > 191)) {
				this.pending = [];
				this.emit({ type: "invalid", reason: "invalid-encoding" });
				this.feed(Uint8Array.of(byte));
				continue;
			}
			const length =
				first < 128
					? 1
					: first >= 194 && first <= 223
						? 2
						: first <= 239 && first >= 224
							? 3
							: first >= 240 && first <= 244
								? 4
								: 1;
			if (this.pending.length < length) continue;
			const value = this.pending;
			this.pending = [];
			if (first === 13 || first === 10)
				this.emit({ type: "key", key: "enter" });
			else if (first === 127 || first === 8)
				this.emit({ type: "key", key: "backspace" });
			else if (first === 9) this.emit({ type: "key", key: "tab" });
			else if (first >= 32) this.decode(value, "text");
		}
	}
	private decode(bytes: number[], type: "text" | "paste"): void {
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(
				Uint8Array.from(bytes),
			);
		} catch {
			this.emit({ type: "invalid", reason: "invalid-encoding" });
			return;
		}
		this.emit({ type, text });
	}
}

export type TerminalExit = {
	reason: "close" | "interrupt" | "signal" | "error";
	signal?: NodeJS.Signals;
	error?: unknown;
};
export function createTerminalSession(options: {
	onKey: (input: TerminalInput) => void;
	onResize: () => void;
	onExit: (exit: TerminalExit) => void;
}): {
	paint: (text: string) => void;
	size: () => { columns: number; rows: number };
	close: () => void;
} {
	const input = process.stdin;
	const output = process.stdout;
	if (!input.isTTY || !output.isTTY || process.env.TERM === "dumb")
		throw new Error("An interactive terminal is required");
	const raw = input.isRaw;
	const paused = input.isPaused();
	let closed = false;
	let entered = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const clearTimer = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	const finish = (exit: TerminalExit) => {
		if (closed) return;
		closed = true;
		clearTimer();
		input.removeListener("data", data);
		input.removeListener("error", error);
		output.removeListener("error", error);
		output.removeListener("resize", resize);
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", terminate);
		let cleanupError: unknown;
		try {
			input.setRawMode(raw);
		} catch (failure) {
			cleanupError = failure;
		}
		try {
			if (paused) input.pause();
			else input.resume();
		} catch (failure) {
			cleanupError ??= failure;
		}
		try {
			if (entered) output.write("\x1b[?2004l\x1b[?25h\x1b[?1049l");
		} catch (failure) {
			cleanupError ??= failure;
		}
		options.onExit(
			cleanupError ? { reason: "error", error: cleanupError } : exit,
		);
	};
	const guarded = (callback: () => void) => {
		try {
			callback();
		} catch (failure) {
			finish({ reason: "error", error: failure });
		}
	};
	const decoder = new TerminalDecoder((event) => {
		if (closed) return;
		if (event.type === "key" && event.key === "ctrl-c")
			finish({ reason: "interrupt" });
		else options.onKey(event);
	});
	const data = (bytes: Buffer) =>
		guarded(() => {
			clearTimer();
			decoder.feed(bytes);
			if (!closed && decoder.awaitingEscape)
				timer = setTimeout(() => guarded(() => decoder.flushEscape()), 25);
		});
	const error = (failure: Error) => finish({ reason: "error", error: failure });
	const resize = () => guarded(options.onResize);
	const interrupt = () => finish({ reason: "interrupt" });
	const terminate = () => finish({ reason: "signal", signal: "SIGTERM" });
	const size = () => ({
		columns: Math.max(1, Math.min(1000, output.columns || 80)),
		rows: Math.max(1, Math.min(1000, output.rows || 24)),
	});
	try {
		input.on("data", data);
		input.on("error", error);
		output.on("error", error);
		output.on("resize", resize);
		process.on("SIGINT", interrupt);
		process.on("SIGTERM", terminate);
		input.setRawMode(true);
		entered = true;
		output.write("\x1b[?1049h\x1b[?25l\x1b[?2004h");
		input.resume();
	} catch (failure) {
		finish({ reason: "error", error: failure });
		throw failure;
	}
	return {
		size,
		close: () => finish({ reason: "close" }),
		paint(text) {
			if (closed) return;
			guarded(() => {
				const { rows, columns } = size();
				const visible = text
					.split("\n", rows)
					.map((line) => fitStyledLine(line, columns))
					.join("\r\n");
				output.write(`\x1b[H\x1b[2J${visible}`);
			});
		},
	};
}
