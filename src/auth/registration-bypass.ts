// Async-context flag that lets trusted server-side flows (e.g. guardian-provisioned
// managed accounts) create a user even when public registration is closed. Public
// requests never enter the store, so the flag is unspoofable from outside.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<{ bypass: true }>();

export function withRegistrationBypass<T>(fn: () => Promise<T>): Promise<T> {
	return store.run({ bypass: true }, fn);
}

export function registrationBypassActive(): boolean {
	return store.getStore()?.bypass === true;
}
