// A real SMTP server, in process, speaking the real protocol over a real
// socket. It exists because M3a's lesson was that every send-path test injected
// a double, so a transport that threw on every real send stayed invisible for
// five tasks. Assertions read the wire: the exact command lines and the exact
// DATA bytes, headers included.
//
// node:net rather than Bun.serve for the same reason tests/support/ntfy-tap.ts
// uses node:http: vitest runs the file in a worker where the Bun global is not
// reliably present.
import { createServer, type Server, type Socket } from "node:net";

export type SinkOptions = {
	// STARTTLS is never advertised: a sink that offered an upgrade it cannot
	// perform would fail every connection for the wrong reason.
	advertiseAuth?: boolean;
	// Replies substituted for the default 250/235, e.g. "550 5.1.1 no such user".
	replies?: Partial<Record<"auth" | "mail" | "rcpt" | "data", string>>;
};

export type SmtpSink = {
	host: string;
	port: number;
	// Every command line the client sent, in order, verbatim.
	commands: string[];
	// The DATA payload of each accepted message, dot-unstuffed.
	messages: string[];
	close(): Promise<void>;
};

function handle(socket: Socket, sink: SmtpSink, options: SinkOptions): void {
	const replies = options.replies ?? {};
	let buffer = "";
	let inData = false;
	let data = "";

	const write = (line: string) => socket.write(`${line}\r\n`);
	write("220 sink ESMTP");

	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		for (;;) {
			const end = buffer.indexOf("\r\n");
			if (end < 0) break;
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);

			if (inData) {
				if (line === ".") {
					inData = false;
					const reply = replies.data ?? "250 2.0.0 Ok: queued";
					if (reply.startsWith("2")) sink.messages.push(data);
					data = "";
					write(reply);
					continue;
				}
				// RFC 5321 dot-stuffing, undone so assertions see the message.
				data += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
				continue;
			}

			sink.commands.push(line);
			const verb = line.split(/[ :]/)[0].toUpperCase();
			if (verb === "EHLO") {
				const extensions = ["8BITMIME", "SMTPUTF8"];
				if (options.advertiseAuth) extensions.push("AUTH PLAIN LOGIN");
				for (const [index, extension] of extensions.entries()) {
					write(
						`250${index === extensions.length - 1 ? " " : "-"}${extension}`,
					);
				}
			} else if (verb === "HELO") {
				write("250 sink");
			} else if (verb === "AUTH") {
				write(replies.auth ?? "235 2.7.0 Authentication successful");
			} else if (verb === "MAIL") {
				write(replies.mail ?? "250 2.1.0 Ok");
			} else if (verb === "RCPT") {
				write(replies.rcpt ?? "250 2.1.5 Ok");
			} else if (verb === "DATA") {
				inData = true;
				write("354 End data with <CR><LF>.<CR><LF>");
			} else if (verb === "QUIT") {
				write("221 2.0.0 Bye");
				socket.end();
			} else {
				write("502 5.5.2 Command not implemented");
			}
		}
	});
	socket.on("error", () => socket.destroy());
}

export async function startSmtpSink(
	options: SinkOptions = {},
): Promise<SmtpSink> {
	const sink: SmtpSink = {
		host: "127.0.0.1",
		port: 0,
		commands: [],
		messages: [],
		close: async () => {},
	};
	const server: Server = createServer((socket) =>
		handle(socket, sink, options),
	);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		// Port 0: the OS picks a free one, so parallel sinks never collide.
		server.listen(0, sink.host, resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("smtp sink: no port");
	}
	sink.port = address.port;
	sink.close = () =>
		new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	return sink;
}
