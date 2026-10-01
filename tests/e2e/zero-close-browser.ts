import { defineMutator, defineMutators, Zero } from "@rocicorp/zero";
import { fetchPublicConfig } from "../../src/web/lib/public-config.ts";
import { fetchZeroToken } from "../../src/web/lib/zero-auth.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { queries } from "../../src/zero/queries.ts";
import { schema } from "../../src/zero/schema.gen.ts";

import { restorePersistenceControls } from "./zero-persistence-controls.ts";

export { holdIdlePersistence } from "./zero-persistence-controls.ts";

let releaseMutation: (() => void) | undefined;
let mutationEntered: (() => void) | undefined;
let heldMutation: Promise<void> | undefined;
type TaskArgs = Parameters<typeof mutators.task.create>[0];
const browserMutators = defineMutators(mutators, {
	task: {
		create: defineMutator<TaskArgs>(async (options) => {
			if (heldMutation) {
				mutationEntered?.();
				await heldMutation;
			}
			await mutators.task.create.fn(options);
		}),
	},
});

function makeClient(
	userID: string,
	token: string,
	cacheURL: string,
	storageKey: string,
) {
	return new Zero({
		userID,
		auth: token,
		cacheURL,
		storageKey,
		schema,
		mutators: browserMutators,
		context: { id: userID },
	});
}
type BrowserZero = ReturnType<typeof makeClient>;
let zero: BrowserZero;
let options: Parameters<typeof makeClient>;
let listId: string;
let closeCalls: [Promise<void>, Promise<void>];
let closeSettled = false;
let acceptedCommit: Promise<unknown>;

export async function openClient(
	userID: string,
	storageKey: string,
	listTitle: string,
) {
	const [token, config] = await Promise.all([
		fetchZeroToken(),
		fetchPublicConfig(),
	]);
	options = [userID, token, config.zeroURL, storageKey];
	window.__zeroCloseControls.captureSockets = true;
	zero = makeClient(...options);
	await Promise.all([
		zero.preload(queries.lists.mine()).complete,
		zero.preload(queries.memberships.mine()).complete,
		zero.preload(queries.tasks.mine()).complete,
	]);
	window.__zeroCloseControls.captureSockets = false;
	const lists = await zero.run(queries.lists.mine());
	const list = lists.find((row) => row.title === listTitle);
	if (!list) throw new Error("browser SDK fixture list did not sync");
	listId = list.id;
	return zero.connection.state.current.name;
}

export async function createTask(title: string, holdCommit = false) {
	let entered: Promise<void> | undefined;
	if (holdCommit) {
		entered = new Promise((resolve) => {
			mutationEntered = resolve;
		});
		heldMutation = new Promise((resolve) => {
			releaseMutation = resolve;
		});
	}
	const mutation = zero.mutate(
		browserMutators.task.create({
			id: crypto.randomUUID(),
			listId,
			title,
			sortKey: "a0",
		}),
	);
	acceptedCommit = mutation.client;
	if (entered) {
		await entered;
		return { type: "held" };
	}
	return await mutation.client;
}

export async function releaseAcceptedMutation() {
	releaseMutation?.();
	heldMutation = undefined;
	return await acceptedCommit;
}

export function beginClose() {
	closeSettled = false;
	closeCalls = [zero.close(), zero.close()];
	void closeCalls[0].then(
		() => {
			closeSettled = true;
		},
		() => {
			closeSettled = true;
		},
	);
	void closeCalls[1].catch(() => {});
	return { samePromise: closeCalls[0] === closeCalls[1] };
}

export function closeSnapshot() {
	return {
		settled: closeSettled,
		connection: zero.connection.state.current.name,
	};
}

export async function closeResults() {
	const results = await Promise.allSettled(closeCalls);
	const errors = results.map((result) =>
		result.status === "rejected" ? result.reason : undefined,
	);
	return {
		statuses: results.map((result) => result.status),
		sameError: errors[0] === errors[1],
		injectedError: errors[0] === window.__zeroCloseControls.failure,
	};
}

export async function tryLateMutation() {
	try {
		const result = await zero.mutate(
			browserMutators.task.create({
				id: crypto.randomUUID(),
				listId,
				title: "Rejected after close",
				sortKey: "a0",
			}),
		).client;
		return {
			refused: result.type === "error" && /closed/i.test(result.error.message),
			result,
		};
	} catch (error) {
		return { refused: true, message: String(error) };
	}
}

export function releasePersistenceCompletion() {
	window.__zeroCloseControls.mode = "observe";
	window.__zeroCloseControls.releaseCompletion?.();
}

export async function retryClose() {
	window.__zeroCloseControls.mode = "observe";
	await zero.close();
}

export async function reopenClient() {
	zero = makeClient(...options);
	return cachedTasks();
}

export async function cachedTasks() {
	return (await zero.run(queries.tasks.mine())).map((task) => task.title);
}

export function socketSnapshot() {
	return window.__zeroCloseControls.sockets.map((socket) => socket.readyState);
}

export async function closeConnectedClient() {
	let reentrantResult: Promise<unknown> | undefined;
	let returned = false;
	let beforeCloseReturned = false;
	const before = zero.connection.state.current.name;
	const unsubscribe = zero.connection.state.subscribe((state) => {
		if (state.name === "closed") {
			beforeCloseReturned = !returned;
			reentrantResult = tryLateMutation();
		}
	});
	try {
		const closing = zero.close();
		returned = true;
		await closing;
		return {
			before,
			after: zero.connection.state.current.name,
			beforeCloseReturned,
			reentrant: await reentrantResult,
		};
	} finally {
		unsubscribe();
	}
}

export async function cleanupClient() {
	releaseMutation?.();
	releasePersistenceCompletion();
	restorePersistenceControls();
	await zero?.close();
}
