import { expect, test, vi } from "vitest";
import type {
	NativeTaskLinkNavigation,
	NativeTaskLinkOpen,
} from "../lib/native-account.tsx";
import { createTaskLinkDelivery } from "./useNativeTaskLinks.ts";

vi.mock("../components/ui/snackbar.tsx", () => ({
	useSnackbar: () => ({ show: vi.fn() }),
}));
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const tick = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture() {
	let listener = () => {};
	let active = true;
	let ready = false;
	const reads: ReturnType<typeof deferred<NativeTaskLinkOpen | null>>[] = [];
	const open = vi.fn(() => true);
	const unavailable = vi.fn();
	const recovery = vi.fn<(retry: () => void) => void>();
	const unsubscribe = vi.fn();
	const navigation: NativeTaskLinkNavigation = {
		identity: "account-a",
		retire: vi.fn(async () => {}),
		read: vi.fn(() => {
			const next = deferred<NativeTaskLinkOpen | null>();
			reads.push(next);
			return next.promise;
		}),
		dismiss: vi.fn(async () => {}),
		subscribe: (next) => {
			listener = next;
			return unsubscribe;
		},
	};
	const delivery = createTaskLinkDelivery(navigation, {
		current: () => active,
		ready: () => ready,
		open,
		unavailable,
		recovery,
	});
	return {
		navigation,
		delivery,
		reads,
		open,
		unavailable,
		recovery,
		unsubscribe,
		emit: () => listener(),
		active: (value: boolean) => {
			active = value;
		},
		ready: () => {
			ready = true;
			delivery.flush();
		},
	};
}
test("delivery waits for actual row readiness and consumes once after accepted navigation", async () => {
	const f = fixture();
	f.reads[0]?.resolve({ token: "one", taskId: "task" });
	await tick();
	expect(f.open).not.toHaveBeenCalled();
	expect(f.navigation.dismiss).not.toHaveBeenCalled();
	f.ready();
	expect(f.open).toHaveBeenCalledWith("task");
	expect(f.navigation.dismiss).toHaveBeenCalledExactlyOnceWith("one");
	f.emit();
	f.reads[1]?.resolve({ token: "one", taskId: "task" });
	await tick();
	expect(f.open).toHaveBeenCalledTimes(1);
	f.delivery.dispose();
});
test("unavailable and invisible targets are consumed without opening or retrying authority", async () => {
	for (const taskId of [null, "private-task"]) {
		const f = fixture();
		f.open.mockReturnValue(false);
		f.ready();
		f.reads[0]?.resolve({ token: "one", taskId });
		await tick();
		expect(f.unavailable).toHaveBeenCalledTimes(1);
		expect(f.open).toHaveBeenCalledTimes(taskId === null ? 0 : 1);
		expect(f.navigation.dismiss).toHaveBeenCalledExactlyOnceWith("one");
		f.delivery.dispose();
	}
});
test("account retirement rejects late results before effect teardown", async () => {
	const f = fixture();
	f.ready();
	f.active(false);
	f.reads[0]?.resolve({ token: "one", taskId: "task" });
	await tick();
	expect(f.open).not.toHaveBeenCalled();
	expect(f.navigation.dismiss).not.toHaveBeenCalled();
	expect(f.unavailable).not.toHaveBeenCalled();
	f.delivery.dispose();
	expect(f.unsubscribe).toHaveBeenCalledTimes(1);
});
test("unmount cancels deferred delivery and subscriptions", async () => {
	const f = fixture();
	f.ready();
	f.delivery.dispose();
	f.reads[0]?.resolve({ token: "one", taskId: "task" });
	await tick();
	f.emit();
	expect(f.open).not.toHaveBeenCalled();
	expect(f.navigation.dismiss).not.toHaveBeenCalled();
	expect(f.reads).toHaveLength(1);
});
test("a newer event invalidates an in-flight read and is read serially", async () => {
	const f = fixture();
	f.ready();
	f.emit();
	expect(f.reads).toHaveLength(1);
	f.reads[0]?.resolve({ token: "stale", taskId: "old" });
	await tick();
	expect(f.open).not.toHaveBeenCalled();
	expect(f.reads).toHaveLength(2);
	f.reads[1]?.resolve({ token: "current", taskId: "new" });
	await tick();
	expect(f.open).toHaveBeenCalledExactlyOnceWith("new");
	expect(f.navigation.dismiss).toHaveBeenCalledExactlyOnceWith("current");
	f.delivery.dispose();
});
test("retirement while awaiting rows cancels already accepted pending target", async () => {
	const f = fixture();
	f.reads[0]?.resolve({ token: "one", taskId: "task" });
	await tick();
	f.active(false);
	f.ready();
	expect(f.open).not.toHaveBeenCalled();
	expect(f.navigation.dismiss).not.toHaveBeenCalled();
	f.delivery.dispose();
});

test("a refused acknowledgement retries the same token and frees the next link without reopening", async () => {
	const f = fixture();
	let host: NativeTaskLinkOpen | null = { token: "one", taskId: "first" };
	vi.mocked(f.navigation.dismiss)
		.mockRejectedValueOnce(new Error("busy"))
		.mockImplementation(async (token) => {
			expect(token).toBe(host?.token);
			host = null;
		});
	f.ready();
	f.reads[0]?.resolve(host);
	await tick();
	expect(f.navigation.dismiss).toHaveBeenCalledTimes(2);
	expect(host).toBeNull();
	expect(f.open).toHaveBeenCalledExactlyOnceWith("first");
	host = { token: "two", taskId: "second" };
	f.emit();
	f.reads[1]?.resolve(host);
	await tick();
	expect(f.open.mock.calls).toEqual([["first"], ["second"]]);
	expect(host).toBeNull();
	expect(f.recovery).not.toHaveBeenCalled();
	f.delivery.dispose();
});
test("exhaustion retains acknowledgement and a busy event or explicit retry never renavigates", async () => {
	const f = fixture();
	f.ready();
	vi.mocked(f.navigation.dismiss).mockRejectedValue(new Error("busy"));
	f.reads[0]?.resolve({ token: "one", taskId: "first" });
	await tick();
	expect(f.navigation.dismiss).toHaveBeenCalledTimes(3);
	expect(f.recovery).toHaveBeenCalledTimes(1);
	f.emit();
	f.reads[1]?.resolve({ token: "one", taskId: "first" });
	await tick();
	expect(f.navigation.dismiss).toHaveBeenCalledTimes(6);
	expect(f.recovery).toHaveBeenCalledTimes(2);
	vi.mocked(f.navigation.dismiss).mockResolvedValue(undefined);
	f.recovery.mock.calls[1]?.[0]();
	await tick();
	expect(f.navigation.dismiss).toHaveBeenCalledTimes(7);
	expect(f.open).toHaveBeenCalledExactlyOnceWith("first");
	f.emit();
	f.reads[2]?.resolve({ token: "two", taskId: "second" });
	await tick();
	expect(f.open.mock.calls).toEqual([["first"], ["second"]]);
	f.delivery.dispose();
});
test("ownership retirement cancels acknowledgement retries and stale recovery actions", async () => {
	const f = fixture();
	f.ready();
	vi.mocked(f.navigation.dismiss).mockImplementation(async () => {
		f.active(false);
		throw new Error("busy");
	});
	f.reads[0]?.resolve({ token: "one", taskId: "first" });
	await tick();
	expect(f.navigation.dismiss).toHaveBeenCalledTimes(1);
	expect(f.recovery).not.toHaveBeenCalled();
	f.delivery.dispose();
	const g = fixture();
	g.ready();
	vi.mocked(g.navigation.dismiss).mockRejectedValue(new Error("busy"));
	g.reads[0]?.resolve({ token: "one", taskId: "first" });
	await tick();
	expect(g.recovery).toHaveBeenCalledTimes(1);
	g.active(false);
	g.recovery.mock.calls[0]?.[0]();
	await tick();
	expect(g.navigation.dismiss).toHaveBeenCalledTimes(3);
	g.delivery.dispose();
});

test("stale native session refusals cancel acknowledgement rather than offering authority retries", async () => {
	for (const code of [
		"unauthorized",
		"no-session",
		"stale-generation",
		"cancelled",
	]) {
		const f = fixture();
		f.ready();
		vi.mocked(f.navigation.dismiss).mockRejectedValue(
			Object.assign(new Error("refused"), { code }),
		);
		f.reads[0]?.resolve({ token: "one", taskId: "first" });
		await tick();
		f.emit();
		f.reads[1]?.resolve({ token: "one", taskId: "first" });
		await tick();
		expect(f.navigation.dismiss).toHaveBeenCalledTimes(1);
		expect(f.open).toHaveBeenCalledExactlyOnceWith("first");
		expect(f.recovery).not.toHaveBeenCalled();
		f.delivery.dispose();
	}
});
