type CommentFocusProjection = {
	node: number;
	tag: string;
	role: string | null;
	testId: string | null;
	disabled: boolean | null;
	connected: boolean;
};
type CommentFocusReceipt = {
	version: 1;
	capacity: 512;
	records: unknown[];
	dropped: number;
	final: unknown;
	restored: boolean;
};
declare global {
	interface Window {
		__diteroCommentFocus?: { stop: () => CommentFocusReceipt };
	}
}

export function installCommentFocusDiagnostics() {
	if (window.__diteroCommentFocus)
		throw new Error("comment focus diagnostics already armed");
	const ids = new WeakMap<Element, number>();
	let nextId = 0;
	let dropped = 0;
	const records: unknown[] = [];
	const started = performance.now();
	const knownTestIds = new Set([
		"comment-input",
		"comment-submit",
		"comment-thread",
		"attachment-rotation-dialog",
		"attachment-rotation-blocked",
		"task-detail",
		"task-detail-title",
		"attachment-input",
	]);
	const roles = new Set([
		"dialog",
		"button",
		"textbox",
		"alert",
		"status",
		"region",
		"combobox",
		"listbox",
		"option",
	]);
	function project(node: unknown): CommentFocusProjection | null {
		if (!(node instanceof Element)) return null;
		let id = ids.get(node);
		if (id === undefined) {
			id = ++nextId;
			ids.set(node, id);
		}
		const testId = node.getAttribute("data-testid");
		const role = node.getAttribute("role");
		return {
			node: id,
			tag: node.localName,
			role: role && roles.has(role) ? role : null,
			testId: testId && knownTestIds.has(testId) ? testId : null,
			disabled: "disabled" in node ? Boolean(node.disabled) : null,
			connected: node.isConnected,
		};
	}
	function record(kind: string, target: unknown = null) {
		const dialogs = [
			...document.querySelectorAll(
				'[data-testid="attachment-rotation-dialog"]',
			),
		].map((node) => ({
			...project(node),
			state: ["open", "closed"].includes(node.getAttribute("data-state") ?? "")
				? node.getAttribute("data-state")
				: null,
		}));
		const row = {
			ms: performance.now() - started,
			kind,
			target: project(target),
			active: project(document.activeElement),
			composer: project(
				document.querySelector('[data-testid="comment-input"]'),
			),
			dialogs,
		};
		if (records.length < 512) records.push(row);
		else dropped++;
	}
	const descriptor = Object.getOwnPropertyDescriptor(
		HTMLElement.prototype,
		"focus",
	);
	if (!descriptor || typeof descriptor.value !== "function")
		throw new Error("focus method unavailable");
	const original: typeof HTMLElement.prototype.focus = descriptor.value;
	const wrapper = function (
		this: HTMLElement,
		...args: Parameters<typeof original>
	) {
		record("focus-before", this);
		try {
			return Reflect.apply(original, this, args);
		} finally {
			record("focus-after", this);
		}
	};
	Object.defineProperty(HTMLElement.prototype, "focus", {
		...descriptor,
		value: wrapper,
	});
	const listener = (event: Event) => record(event.type, event.target);
	document.addEventListener("focusin", listener, true);
	document.addEventListener("focusout", listener, true);
	const observer = new MutationObserver(() => record("dom"));
	observer.observe(document.documentElement, {
		subtree: true,
		childList: true,
		attributes: true,
		attributeFilter: ["disabled", "data-state"],
	});
	const api = {
		stop(): CommentFocusReceipt {
			record("final");
			const final = {
				ms: performance.now() - started,
				active: project(document.activeElement),
				composer: project(
					document.querySelector('[data-testid="comment-input"]'),
				),
				dialogCount: document.querySelectorAll(
					'[data-testid="attachment-rotation-dialog"]',
				).length,
			};
			observer.disconnect();
			document.removeEventListener("focusin", listener, true);
			document.removeEventListener("focusout", listener, true);
			const restored = HTMLElement.prototype.focus === wrapper;
			if (restored)
				Object.defineProperty(HTMLElement.prototype, "focus", descriptor);
			if (window.__diteroCommentFocus === api)
				delete window.__diteroCommentFocus;
			return { version: 1, capacity: 512, records, dropped, final, restored };
		},
	};
	window.__diteroCommentFocus = api;
	record("armed");
}
