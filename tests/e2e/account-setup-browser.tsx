import { useQuery, useZero } from "@rocicorp/zero/react";
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	type AccountSetupRequest,
	accountSetupRequestSchema,
} from "../../src/domain/account-setup.ts";
import { AccountSetupPanel } from "../../src/web/components/setup/AccountSetupPanel.tsx";
import { useAccountSetup } from "../../src/web/hooks/useAccountSetup.ts";
import { mutationResultFailure } from "../../src/web/lib/run-mutation.ts";
import { AppZeroProvider } from "../../src/web/lib/zero.tsx";
import { retireZeroClients } from "../../src/web/lib/zero-lifecycle.ts";
import { queries } from "../../src/zero/queries.ts";
import type { schema } from "../../src/zero/schema.gen.ts";

type Controller = ReturnType<typeof useAccountSetup>;
let root: Root | undefined;
let controller: Controller | undefined;
let currentSnapshot:
	| {
			userID: string | undefined;
			complete: boolean;
			rows: Array<{
				id: string;
				outcome: string | null;
				revision: number | null;
				receipt: unknown;
			}>;
			state: Controller["state"];
			error: Controller["error"];
			outcome: Controller["outcome"];
			revision: number;
			requestId: string;
			request: AccountSetupRequest | null;
			online: boolean;
			managed: boolean;
	  }
	| undefined;
let injectAcknowledgementError = false;
let writes: AccountSetupRequest[] = [];
let acknowledgements: Array<{
	requestId: string;
	committed: boolean;
	injected: boolean;
}> = [];

function Probe({ email }: { email: string }) {
	const zero = useZero<typeof schema>();
	const [rows, details] = useQuery(queries.accountSetup.mine());
	const setup = useAccountSetup({ currentLocale: "en", profileEmail: email });
	const [expanded, setExpanded] = useState(true);
	useEffect(() => {
		const original = zero.mutate;
		const intercepted = (descriptor: Parameters<typeof original>[0]) => {
			const request = accountSetupRequestSchema.parse(descriptor.args);
			if (request.mode === "guided") Object.freeze(descriptor.args.starterKeys);
			Object.freeze(descriptor.args);
			writes.push(request);
			const mutation = original(descriptor);
			return {
				...mutation,
				server: mutation.server.then((result) => {
					const committed = mutationResultFailure(result) === null;
					const injected = committed && injectAcknowledgementError;
					acknowledgements.push({
						requestId: request.requestId,
						committed,
						injected,
					});
					if (!injected) return result;
					injectAcknowledgementError = false;
					// The real guarded mutation and commit finish first; only this test caller's acknowledgement is replaced.
					return {
						type: "error",
						error: { type: "zero", message: "Injected acknowledgement error" },
					} as typeof result;
				}),
			};
		};
		Object.assign(intercepted, original);
		Object.defineProperty(zero, "mutate", {
			value: intercepted,
			configurable: true,
		});
		return () => {
			Object.defineProperty(zero, "mutate", {
				value: original,
				configurable: true,
			});
			controller = undefined;
			currentSnapshot = undefined;
		};
	}, [zero]);
	useEffect(() => {
		controller = setup;
		currentSnapshot = {
			userID: zero.userID,
			complete: details.type === "complete" && setup.authoritative,
			rows: rows.map((row) => ({
				id: row.id,
				outcome: row.outcome,
				revision: row.revision,
				receipt: row.latestReceipt,
			})),
			state: setup.state,
			error: setup.error,
			outcome: setup.outcome,
			revision: setup.revision,
			requestId: setup.requestId,
			request: setup.request,
			online: setup.online,
			managed: setup.managed,
		};
	});
	return (
		<main>
			<h1>Setup browser probe</h1>
			<h2>Account</h2>
			<AccountSetupPanel
				setup={setup}
				expanded={expanded}
				onOpen={() => setExpanded(true)}
				onLeave={() => setExpanded(false)}
			/>
		</main>
	);
}
export function mount(userID: string, email: string) {
	if (root)
		throw new Error(
			"Retire the existing probe before mounting another account",
		);
	writes = [];
	acknowledgements = [];
	injectAcknowledgementError = false;
	const node = document.createElement("div");
	document.body.append(node);
	root = createRoot(node);
	root.render(
		<AppZeroProvider key={userID} userID={userID}>
			<Probe email={email} />
		</AppZeroProvider>,
	);
}
export function snapshot() {
	return { ...currentSnapshot, writes, acknowledgements };
}
function readyController() {
	if (!controller) throw new Error("Setup probe is not mounted");
	return controller;
}
export async function submitChoice(
	mode: AccountSetupRequest["mode"],
	starterKeys: Array<"shopping" | "packing" | "cleaning"> = [],
	dashboard = false,
) {
	const setup = readyController();
	const common = {
		requestId: setup.requestId,
		expectedRevision: setup.expectedRevision,
		catalogVersion: 1,
		locale: setup.locale,
	};
	await setup.submit(
		accountSetupRequestSchema.parse(
			mode === "guided"
				? { ...common, mode, starterKeys, dashboard }
				: { ...common, mode },
		),
	);
}
export function injectNextAcknowledgementError() {
	injectAcknowledgementError = true;
}
export async function retry() {
	await readyController().retry();
}
export async function resume() {
	await readyController().resume();
}
export function fresh() {
	readyController().fresh();
}
export async function retire() {
	await retireZeroClients();
	root?.unmount();
	root = undefined;
	controller = undefined;
	currentSnapshot = undefined;
}
