import { parentPort } from "node:worker_threads";
import type { ImportParseJob } from "./import-parser-protocol.ts";
import { performImportParse } from "./import-parser-work.ts";

const port = parentPort;
if (!port) throw new Error("Import parser requires a worker");
port.on(
	"message",
	async ({ job, budget }: { job: ImportParseJob; budget: number }) => {
		port.postMessage(await performImportParse(job, budget));
	},
);
