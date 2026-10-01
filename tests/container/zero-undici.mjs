import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

async function handshake(unsolicitedProtocol) {
	const server = createServer();
	const sockets = new Set();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.on("upgrade", (request, socket) => {
		const accept = createHash("sha1")
			.update(
				request.headers["sec-websocket-key"] +
					"258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
			)
			.digest("base64");
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\n" +
				"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${accept}\r\n` +
				(unsolicitedProtocol ? "Sec-WebSocket-Protocol: unsolicited\r\n" : "") +
				"\r\n",
		);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	let deadline;
	try {
		await new Promise((resolve, reject) => {
			deadline = setTimeout(
				() => reject(new Error("Handshake timed out")),
				5000,
			);
			const websocket = new WebSocket(
				`ws://127.0.0.1:${server.address().port}`,
			);
			websocket.addEventListener("open", () => {
				if (unsolicitedProtocol) {
					reject(new Error("Unsolicited protocol accepted"));
				} else {
					resolve();
				}
			});
			websocket.addEventListener("error", () => {
				if (unsolicitedProtocol) {
					resolve();
				} else {
					reject(new Error("Valid handshake rejected"));
				}
			});
		});
	} finally {
		clearTimeout(deadline);
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
	}
}

assert.equal(typeof WebSocket, "function");
await handshake(false);
await handshake(true);
console.log(
	"Valid WebSocket handshake accepted; unsolicited protocol safely rejected",
);
