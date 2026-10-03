import { createTerminalSession } from "../../src/tui/terminal";

const mode = process.argv[2] ?? "close";
if (mode === "child") {
	const scenario = process.argv[3];
	if (scenario === "paused") process.stdin.pause();
	if (scenario === "raw") process.stdin.setRawMode(true);
	const owner = () => {};
	process.stdin.on("data", owner);
	process.on("SIGTERM", owner);
	const before = {
		raw: !!process.stdin.isRaw,
		paused: process.stdin.isPaused(),
		data: process.stdin.listenerCount("data"),
		signal: process.listenerCount("SIGTERM"),
	};
	if (scenario === "startup") {
		const original = process.stdin.setRawMode.bind(process.stdin);
		process.stdin.setRawMode = (enabled) => {
			const result = original(enabled);
			if (enabled) throw new Error("startup failed");
			return result;
		};
	}
	let exits = 0;
	try {
		const session = createTerminalSession({
			onKey(event) {
				process.stdout.write(`EVENT:${JSON.stringify(event)}\n`);
				if (scenario === "error") throw new Error("callback failed");
				if (event.type === "key" && event.key === "enter") {
					session.close();
					session.close();
				}
			},
			onResize() {
				process.stdout.write(`RESIZE:${JSON.stringify(session.size())}\n`);
			},
			onExit(exit) {
				exits++;
				process.stdout.write(
					`EXIT:${JSON.stringify({ ...exit, exits, before, after: { raw: !!process.stdin.isRaw, paused: process.stdin.isPaused(), data: process.stdin.listenerCount("data"), signal: process.listenerCount("SIGTERM") } })}\n`,
				);
				setImmediate(() => process.exit(0));
			},
		});
		session.paint("0123456789".repeat(20) + "\nline\n".repeat(30));
		process.stdout.write("READY\n");
	} catch (error) {
		if (scenario !== "startup") throw error;
	}
} else if (mode === "notty" || mode === "dumb") {
	try {
		createTerminalSession({ onKey() {}, onResize() {}, onExit() {} });
	} catch {
		process.stdout.write("REFUSED\n");
	}
} else {
	let output = "";
	const terminal = new Bun.Terminal({
		cols: 20,
		rows: 5,
		data(_terminal, bytes) {
			output += new TextDecoder().decode(bytes);
		},
	});
	const flags = () => [
		terminal.inputFlags,
		terminal.outputFlags,
		terminal.localFlags,
		terminal.controlFlags,
	];
	const before = flags();
	const proc = Bun.spawn(
		[
			process.execPath,
			import.meta.path,
			mode === "dumb-pty" ? "dumb" : "child",
			mode,
		],
		{
			terminal,
			env: {
				...process.env,
				TERM: mode === "dumb-pty" ? "dumb" : "xterm-256color",
			},
		},
	);
	const deadline = Date.now() + 10000;
	const waitFor = async (needle: string) => {
		while (!output.includes(needle)) {
			if (Date.now() > deadline)
				throw new Error(`Missing ${needle}: ${output}`);
			await Bun.sleep(5);
		}
	};
	const timeout = setTimeout(() => proc.kill("SIGKILL"), 12000);
	try {
		if (mode !== "dumb-pty" && mode !== "startup") {
			await waitFor("READY");
			terminal.resize(31, 9);
			proc.kill("SIGWINCH");
			await waitFor("RESIZE:");
			if (mode === "signal") proc.kill("SIGTERM");
			else if (mode === "interrupt") terminal.write("\x03");
			else if (mode === "error") terminal.write("x");
			else {
				terminal.write(new Uint8Array([0xc3]));
				await Bun.sleep(5);
				terminal.write(new Uint8Array([0xa9]));
				terminal.write("\x1b[20");
				terminal.write("0~hello\nworld\x1b[201~");
				terminal.write("\x1b");
				await waitFor('"key":"escape"');
				terminal.write("\r");
			}
		}
		const code = await proc.exited;
		await Bun.sleep(20);
		process.stdout.write(
			JSON.stringify({ code, output, before, after: flags() }),
		);
	} finally {
		clearTimeout(timeout);
		if (proc.exitCode === null) {
			proc.kill("SIGKILL");
			await proc.exited;
		}
		terminal.close();
	}
}
