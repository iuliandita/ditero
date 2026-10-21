import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function capture(
	command,
	args,
	{ limit = 131072, timeout = 15000 } = {},
) {
	return new Promise((resolveResult) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		const chunks = [];
		let bytes = 0;
		let truncated = false;
		let timedOut = false;
		let error;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeout);
		const collect = (chunk) => {
			const remaining = limit - bytes;
			if (remaining > 0) {
				const part = chunk.subarray(0, remaining);
				chunks.push(part);
				bytes += part.length;
			}
			if (chunk.length > remaining) {
				truncated = true;
				child.kill("SIGKILL");
			}
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("error", (failure) => {
			error = failure.code;
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolveResult({
				output: Buffer.concat(chunks),
				code,
				signal,
				truncated,
				timedOut,
				error,
			});
		});
	});
}

async function main() {
	const [context, namespace, directory, ...extra] = process.argv.slice(2);
	if (
		!context ||
		!namespace ||
		!directory ||
		extra.length ||
		!/^[-\w.:]+$/.test(context) ||
		!/^[a-z0-9][a-z0-9-]*$/.test(namespace)
	)
		throw new Error(
			"Usage: node tests/container/kubernetes-diagnostics.mjs CONTEXT NAMESPACE NEW_PRIVATE_DIRECTORY",
		);
	const outputDirectory = resolve(directory);
	await mkdir(outputDirectory, { mode: 0o700 });
	const records = [];
	const deadline = Date.now() + 120000;
	const collect = async (name, args) => {
		const remaining = deadline - Date.now();
		if (remaining <= 0)
			throw new Error(
				"Diagnostic capture exceeded two minutes; see capture.json",
			);
		const { output, ...status } = await capture(
			"kubectl",
			[
				"--context",
				context,
				"--namespace",
				namespace,
				"--request-timeout=10s",
				...args,
			],
			{ timeout: Math.min(15000, remaining) },
		);
		await writeFile(resolve(outputDirectory, name), output, { mode: 0o600 });
		records.push({ name, args, bytes: output.length, ...status });
		return { output, ...status };
	};
	try {
		await collect("resources.txt", ["get", "pods,pvc,service", "-o", "wide"]);
		await collect("events.txt", ["get", "events", "--sort-by=.lastTimestamp"]);
		await collect("describe.txt", ["describe", "pods"]);
		const pods = await collect("pods.json", ["get", "pods", "-o", "json"]);
		if (pods.code !== 0 || pods.truncated || pods.timedOut)
			throw new Error("Pod inventory was incomplete; see capture.json");
		const { items } = JSON.parse(pods.output);
		if (!Array.isArray(items) || items.length > 32)
			throw new Error(
				"Expected at most 32 pods in the qualification namespace",
			);
		for (const pod of items) {
			const containers = [
				...(pod.spec.initContainers ?? []),
				...pod.spec.containers,
			];
			if (containers.length > 8)
				throw new Error("Too many containers in a qualification pod");
			for (const container of containers) {
				for (const previous of [false, true]) {
					const name = `${pod.metadata.name}-${container.name}${previous ? "-previous" : ""}.log`;
					await collect(name, [
						"logs",
						pod.metadata.name,
						"-c",
						container.name,
						"--tail=150",
						"--limit-bytes=65536",
						"--timestamps=true",
						...(previous ? ["--previous"] : []),
					]);
				}
			}
		}
	} finally {
		await writeFile(
			resolve(outputDirectory, "capture.json"),
			JSON.stringify(records, null, 2),
			{ mode: 0o600 },
		);
	}
	console.log(
		"Bounded Kubernetes diagnostics saved; inspect capture.json before cleanup.",
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
