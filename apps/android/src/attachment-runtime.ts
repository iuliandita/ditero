import { sanitiseFilename } from "../../../src/domain/attachment.ts";
import { withCiphertextStage } from "../../../src/web/lib/e2e/ciphertext-staging.ts";
import type {
	AttachmentFileWriter,
	CiphertextStageRunner,
	DownloadDestination,
} from "../../../src/web/lib/e2e/download.ts";
import type { AttachmentRuntime } from "../../../src/web/lib/e2e/runtime.ts";
import type { E2eFetcher } from "../../../src/web/lib/e2e/workspace-keys.ts";
import { type AttachmentOp, callAttachment } from "./bridge.ts";

const CHUNK = 32768;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
type Call = typeof callAttachment;
type Reply = Awaited<ReturnType<Call>>;
function id(reply: Reply, name: string): string {
	const value = reply[name];
	if (typeof value !== "string" || !ID.test(value))
		throw new TypeError("native file capability refused");
	return value;
}
function response(reply: Reply): Response {
	const status = reply.status;
	if (
		typeof status !== "number" ||
		!Number.isInteger(status) ||
		status < 200 ||
		status > 599 ||
		!(reply.body === null || typeof reply.body === "string")
	)
		throw new TypeError("native file response refused");
	return new Response([204, 205, 304].includes(status) ? null : reply.body, {
		status,
		headers: { "content-type": "application/json" },
	});
}
function encode(bytes: Uint8Array): string {
	let value = "";
	for (const byte of bytes) value += String.fromCharCode(byte);
	return btoa(value);
}
function decode(reply: Reply): Uint8Array<ArrayBuffer> {
	if (
		typeof reply.data !== "string" ||
		reply.data.length > 43692 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			reply.data,
		)
	)
		throw new TypeError("native file chunk refused");
	const raw = atob(reply.data);
	if (raw.length > CHUNK || btoa(raw) !== reply.data)
		throw new TypeError("native file chunk refused");
	return Uint8Array.from(raw, (value) => value.charCodeAt(0));
}
async function* chunks(
	input: ReadableStream<Uint8Array>,
	signal?: AbortSignal | null,
): AsyncIterable<Uint8Array> {
	const reader = input.getReader();
	let complete = false;
	try {
		while (true) {
			signal?.throwIfAborted();
			const next = await reader.read();
			if (next.done) {
				complete = true;
				return;
			}
			if (!(next.value instanceof Uint8Array))
				throw new TypeError("native upload bytes refused");
			for (let offset = 0; offset < next.value.length; offset += CHUNK)
				yield next.value.subarray(offset, offset + CHUNK);
		}
	} finally {
		if (!complete) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
function route(
	input: Parameters<E2eFetcher>[0],
	init?: RequestInit,
): {
	op: AttachmentOp;
	body: Record<string, unknown>;
	kind: "control" | "upload" | "download";
} {
	if (typeof input !== "string" || /[?#\\%]/.test(input))
		throw new TypeError("native attachment target refused");
	for (const [name] of new Headers(init?.headers))
		if (!["content-type", "accept"].includes(name))
			throw new TypeError("native attachment headers refused");
	const method = (init?.method ?? "GET").toUpperCase();
	if (input === "/api/attachments/config" && method === "GET" && !init?.body)
		return { op: "attachment.config", body: {}, kind: "control" };
	const control = /^\/api\/attachments\/(reserve|finalize|abort|delete)$/.exec(
		input,
	);
	if (
		control &&
		method === "POST" &&
		typeof init?.body === "string" &&
		new TextEncoder().encode(init.body).length <= 2 * 1024 * 1024
	) {
		const body: unknown = JSON.parse(init.body);
		if (!body || typeof body !== "object" || Array.isArray(body))
			throw new TypeError("native attachment body refused");
		return {
			op: `attachment.${control[1]}` as
				| "attachment.reserve"
				| "attachment.finalize"
				| "attachment.abort"
				| "attachment.delete",
			body: Object.fromEntries(Object.entries(body)),
			kind: "control",
		};
	}
	const item =
		/^\/api\/attachments\/([A-Za-z0-9_-]{1,128})(?:\/(upload|thumbnail|download))?$/.exec(
			input,
		);
	if (item) {
		const attachmentId = item[1];
		const suffix = item[2];
		if ((suffix === "upload" || suffix === "thumbnail") && method === "POST")
			return {
				op: "upload.begin",
				body: { attachmentId, thumbnail: suffix === "thumbnail" },
				kind: "upload",
			};
		if (
			(suffix === "download" || suffix === "thumbnail") &&
			method === "GET" &&
			!init?.body
		)
			return {
				op: "download.begin",
				body: { attachmentId, thumbnail: suffix === "thumbnail" },
				kind: "download",
			};
	}
	throw new TypeError("native attachment target refused");
}

/** Bound to one verified account. Native owns all URLs, credentials and paths. */
export function createAttachmentRuntime(
	assertCurrent: () => void,
	scope: string,
	desktop: boolean,
	call: Call = callAttachment,
): AttachmentRuntime {
	const declared = new Map<string, number>();
	const checked: Call = async (op, body = {}) => {
		assertCurrent();
		const result = await call(op, body);
		assertCurrent();
		return result;
	};
	const cancel = async (op: AttachmentOp, body: Record<string, unknown>) => {
		// Retired native owners already cancel every capability. Never address a replacement.
		try {
			await checked(op, body);
		} catch {
			/* Cleanup cannot replace the original failure. */
		}
	};
	const fetcher: E2eFetcher = async (input, init) => {
		assertCurrent();
		init?.signal?.throwIfAborted();
		const resolved = route(input, init);
		if (resolved.kind === "control") {
			const result = response(await checked(resolved.op, resolved.body));
			init?.signal?.throwIfAborted();
			if (resolved.op === "attachment.reserve" && result.ok) {
				const body = resolved.body;
				if (
					typeof body.id !== "string" ||
					!ID.test(body.id) ||
					!Number.isSafeInteger(body.declaredBytes) ||
					Number(body.declaredBytes) <= 0
				)
					throw new TypeError("native upload size refused");
				declared.set(`${body.id}:false`, Number(body.declaredBytes));
				if (body.thumbnailDeclaredBytes != null) {
					if (
						!Number.isSafeInteger(body.thumbnailDeclaredBytes) ||
						Number(body.thumbnailDeclaredBytes) <= 0
					)
						throw new TypeError("native thumbnail size refused");
					declared.set(`${body.id}:true`, Number(body.thumbnailDeclaredBytes));
				}
			}
			if (
				[
					"attachment.finalize",
					"attachment.abort",
					"attachment.delete",
				].includes(resolved.op)
			) {
				declared.delete(`${resolved.body.id}:false`);
				declared.delete(`${resolved.body.id}:true`);
			}
			return result;
		}
		if (resolved.kind === "upload") {
			const bytes = declared.get(
				`${resolved.body.attachmentId}:${resolved.body.thumbnail}`,
			);
			if (!bytes || !(init?.body instanceof ReadableStream))
				throw new TypeError("native upload requires reserved streaming bytes");
			const begun = await checked("upload.begin", { ...resolved.body, bytes });
			if (!begun.ok) return response(begun);
			const transferId = id(begun, "transferId");
			const abort = () => {
				void cancel("attachment.cancel", { transferId });
			};
			init.signal?.addEventListener("abort", abort, { once: true });
			let seq = 0;
			try {
				init.signal?.throwIfAborted();
				for await (const chunk of chunks(init.body, init.signal)) {
					await checked("upload.write", {
						transferId,
						seq: seq++,
						data: encode(chunk),
					});
					init.signal?.throwIfAborted();
				}
				return response(await checked("upload.finish", { transferId, seq }));
			} finally {
				init.signal?.removeEventListener("abort", abort);
				await cancel("attachment.cancel", { transferId });
			}
		}
		const begun = await checked("download.begin", resolved.body);
		if (!begun.ok) return response(begun);
		const transferId = id(begun, "transferId");
		const status = begun.status;
		if (
			typeof status !== "number" ||
			status < 200 ||
			status > 299 ||
			!Number.isInteger(status)
		) {
			await cancel("attachment.cancel", { transferId });
			throw new TypeError("native download response refused");
		}
		let seq = 0;
		let retired = false;
		const finish = async () => {
			if (retired) return;
			retired = true;
			init?.signal?.removeEventListener("abort", abort);
			await cancel("attachment.cancel", { transferId });
		};
		let streamController: ReadableStreamDefaultController<Uint8Array>;
		const abort = () => {
			if (!retired)
				streamController.error(
					init?.signal?.reason ?? new DOMException("Aborted", "AbortError"),
				);
			void finish();
		};
		const stream = new ReadableStream<Uint8Array>(
			{
				start(controller) {
					streamController = controller;
					init?.signal?.addEventListener("abort", abort, { once: true });
					if (init?.signal?.aborted) abort();
				},
				async pull(controller) {
					if (retired) return;
					try {
						const reply = await checked("download.read", {
							transferId,
							seq: seq++,
						});
						if (retired) return;
						if (typeof reply.eof !== "boolean")
							throw new TypeError("native download end refused");
						const data = decode(reply);
						if (reply.eof) {
							if (data.length)
								throw new TypeError("native download trailing data refused");
							controller.close();
							await finish();
						} else {
							if (!data.length)
								throw new TypeError("native download empty chunk refused");
							controller.enqueue(data);
						}
					} catch (error) {
						if (!retired) controller.error(error);
						await finish();
					}
				},
				cancel: finish,
			},
			{ highWaterMark: 0 },
		);
		const headers = new Headers();
		if (
			typeof begun.bytes === "number" &&
			Number.isSafeInteger(begun.bytes) &&
			begun.bytes >= 0
		)
			headers.set("content-length", String(begun.bytes));
		return new Response(stream, { status, headers });
	};

	function writer(
		capability: string,
		kind: "save" | "stage",
	): AttachmentFileWriter {
		let seq = 0;
		let closed = false;
		const key = kind === "save" ? "saveId" : "stageId";
		return {
			async write(chunk) {
				if (closed) throw new TypeError("native file writer closed");
				for (let offset = 0; offset < chunk.length; offset += CHUNK)
					await checked(`${kind}.write`, {
						[key]: capability,
						seq: seq++,
						data: encode(chunk.subarray(offset, offset + CHUNK)),
					});
			},
			async close() {
				if (closed) throw new TypeError("native file writer closed");
				if (kind === "save")
					await checked("save.finish", { saveId: capability, seq });
				closed = true;
			},
			async abort() {
				closed = true;
				await cancel(`${kind}.cancel`, { [key]: capability });
			},
		};
	}
	let picking = false;
	const pickFile = async (
		filename: string,
		signal?: AbortSignal,
	): Promise<DownloadDestination> => {
		signal?.throwIfAborted();
		if (picking) throw new TypeError("native file picker busy");
		picking = true;
		let saveId: string;
		let rejectAbort: ((error: unknown) => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			rejectAbort = reject;
		});
		const abort = () => {
			void cancel("save.cancelPending", {});
			rejectAbort?.(
				signal?.reason ?? new DOMException("Aborted", "AbortError"),
			);
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const picked = checked("save.pick", {
				filename: sanitiseFilename(filename).slice(0, 255),
			}).then(async (reply) => {
				const capability = id(reply, "saveId");
				if (signal?.aborted) {
					await cancel("save.cancel", { saveId: capability });
					signal.throwIfAborted();
				}
				return capability;
			});
			saveId = await Promise.race([picked, aborted]);
		} catch (error) {
			await cancel("save.cancelPending", {});
			throw error;
		} finally {
			picking = false;
			signal?.removeEventListener("abort", abort);
		}
		let opened = false;
		return {
			async createWritable() {
				assertCurrent();
				signal?.throwIfAborted();
				if (opened) throw new TypeError("native file writer already opened");
				opened = true;
				return writer(saveId, "save");
			},
			async cancel() {
				await cancel("save.cancel", { saveId });
			},
		};
	};
	const withStage: CiphertextStageRunner = desktop
		? async (use) => {
				const stageId = id(await checked("stage.begin", {}), "stageId");
				let written = false;
				try {
					return await use({
						async createWritable() {
							if (written) throw new TypeError("native stage already written");
							written = true;
							return writer(stageId, "stage");
						},
						async getFile() {
							return {
								stream() {
									let seq = 0;
									return new ReadableStream<Uint8Array>(
										{
											async start() {
												await checked("stage.rewind", { stageId });
											},
											async pull(controller) {
												const reply = await checked("stage.read", {
													stageId,
													seq: seq++,
												});
												if (typeof reply.eof !== "boolean")
													throw new TypeError("native stage end refused");
												const data = decode(reply);
												if (reply.eof) {
													if (data.length)
														throw new TypeError(
															"native stage trailing data refused",
														);
													controller.close();
												} else {
													if (!data.length)
														throw new TypeError(
															"native stage empty chunk refused",
														);
													controller.enqueue(data);
												}
											},
										},
										{ highWaterMark: 0 },
									);
								},
							};
						},
					});
				} finally {
					await cancel("stage.cancel", { stageId });
				}
			}
		: (use) => withCiphertextStage(use, scope);
	return { fetcher, pickFile, withStage };
}
