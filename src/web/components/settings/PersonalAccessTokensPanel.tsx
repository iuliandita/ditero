import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { tokenCreateSchema } from "../../../domain/public-api.ts";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { authClient } from "../../lib/auth-client.ts";
import { copyText } from "../../lib/clipboard.ts";
import { Button } from "../ui/button.tsx";
import { useConfirm } from "../ui/confirm.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog.tsx";
import { Input } from "../ui/input.tsx";

const metadataSchema = z.object({
	id: z.uuid(),
	name: z.string().max(80),
	hint: z.string().max(4),
	access: z.enum(["read", "write"]),
	createdAt: z.iso.datetime(),
	expiresAt: z.iso.datetime(),
	revokedAt: z.iso.datetime().nullable(),
});
const createdSchema = metadataSchema.extend({
	token: z.string().regex(/^ditero_pat_[A-Za-z0-9_-]{43}$/),
});
export type PersonalAccessTokenMetadata = z.infer<typeof metadataSchema>;

class TokenRequestError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

export async function requestPersonalAccessTokens<T>(
	path: string,
	schema: z.ZodType<T>,
	options: RequestInit,
): Promise<T> {
	const response = await fetch(`/api/personal-access-tokens${path}`, {
		...options,
		credentials: "include",
		cache: "no-store",
	});
	if (!response.ok) {
		const problem = z
			.object({ code: z.string() })
			.safeParse(await response.json().catch(() => null));
		throw new TokenRequestError(
			problem.success
				? problem.data.code
				: response.status === 401
					? "unauthorized"
					: "request-failed",
		);
	}
	return z
		.object({ version: z.literal(1), data: schema, nextCursor: z.null() })
		.parse(await response.json()).data;
}

export function tokenStatus(
	token: PersonalAccessTokenMetadata,
	now = Date.now(),
): "active" | "expired" | "revoked" {
	return token.revokedAt
		? "revoked"
		: new Date(token.expiresAt).getTime() <= now
			? "expired"
			: "active";
}

export function tokenErrorMessage(failure: unknown): string {
	if (failure instanceof TokenRequestError) {
		switch (failure.code) {
			case "unauthorized":
				return m.pat_error_session();
			case "token-limit":
				return m.pat_limit();
			case "invalid-token-request":
				return m.pat_error_invalid();
			case "rate-limited":
			case "temporarily-unavailable":
				return m.pat_error_retry();
			case "not-found":
				return m.pat_error_missing();
		}
	}
	return m.pat_error_failed();
}

export function PersonalAccessTokensPanel() {
	const { data: session } = authClient.useSession();
	return session?.user.id ? (
		<TokenAccountPanel key={session.user.id} />
	) : (
		<p className="text-sm text-muted-foreground">{m.pat_error_session()}</p>
	);
}

function TokenAccountPanel() {
	const confirm = useConfirm();
	const nameId = useId();
	const accessId = useId();
	const expiryId = useId();
	const [tokens, setTokens] = useState<PersonalAccessTokenMetadata[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [access, setAccess] = useState<"read" | "write">("read");
	const [expiry, setExpiry] = useState("90");
	const [secret, setSecret] = useState<string | null>(null);
	const [copyStatus, setCopyStatus] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [revision, setRevision] = useState(0);
	const owner = useRef(0);
	const dialogOwner = useRef(0);
	const action = useRef<AbortController | null>(null);
	const locked = useRef(false);

	useEffect(() => {
		return () => {
			owner.current++;
			dialogOwner.current++;
			action.current?.abort();
		};
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly reloads token metadata.
	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		void requestPersonalAccessTokens("", z.array(metadataSchema).max(100), {
			signal: controller.signal,
		})
			.then((rows) => {
				if (!controller.signal.aborted) setTokens(rows);
			})
			.catch((failure) => {
				if (!controller.signal.aborted) setError(tokenErrorMessage(failure));
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [revision]);

	function changeDialog(next: boolean) {
		dialogOwner.current++;
		action.current?.abort();
		action.current = null;
		locked.current = false;
		setBusy(false);
		setSecret(null);
		setCopyStatus(null);
		setError(null);
		setName("");
		setAccess("read");
		setExpiry("90");
		setOpen(next);
		if (!next) setRevision((value) => value + 1);
	}

	async function create() {
		if (locked.current) return;
		const parsed = tokenCreateSchema.safeParse({
			name,
			access,
			expiresInDays: Number(expiry),
		});
		if (!parsed.success) {
			setError(m.pat_error_invalid());
			return;
		}
		locked.current = true;
		setBusy(true);
		setError(null);
		const controller = new AbortController();
		action.current = controller;
		const epoch = dialogOwner.current;
		try {
			const result = await requestPersonalAccessTokens("", createdSchema, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(parsed.data),
				signal: controller.signal,
			});
			if (controller.signal.aborted || epoch !== dialogOwner.current) return;
			setSecret(result.token);
			setRevision((value) => value + 1);
		} catch (failure) {
			if (!controller.signal.aborted && epoch === dialogOwner.current)
				setError(tokenErrorMessage(failure));
		} finally {
			if (!controller.signal.aborted && epoch === dialogOwner.current) {
				locked.current = false;
				setBusy(false);
				action.current = null;
			}
		}
	}

	async function copy() {
		if (!secret) return;
		const epoch = dialogOwner.current;
		const copied = await copyText(secret);
		if (epoch === dialogOwner.current)
			setCopyStatus(copied ? m.channel_copied() : m.pat_copy_failed());
	}

	async function revoke(token: PersonalAccessTokenMetadata) {
		if (locked.current) return;
		locked.current = true;
		setBusy(true);
		const epoch = owner.current;
		const accepted = await confirm({
			title: m.pat_revoke_title({ name: token.name }),
			body: m.pat_revoke_body(),
			confirmLabel: m.pat_revoke(),
			destructive: true,
		});
		if (epoch !== owner.current) return;
		if (!accepted) {
			locked.current = false;
			setBusy(false);
			return;
		}
		const controller = new AbortController();
		action.current = controller;
		setError(null);
		try {
			await requestPersonalAccessTokens(
				`/${encodeURIComponent(token.id)}`,
				z.object({ id: z.uuid(), revoked: z.literal(true) }),
				{ method: "DELETE", signal: controller.signal },
			);
			if (!controller.signal.aborted) setRevision((value) => value + 1);
		} catch (failure) {
			if (!controller.signal.aborted) setError(tokenErrorMessage(failure));
		} finally {
			if (!controller.signal.aborted) {
				locked.current = false;
				setBusy(false);
				action.current = null;
			}
		}
	}

	const limitReached =
		tokens.filter((token) => tokenStatus(token) === "active").length >= 20;
	return (
		<div data-testid="personal-access-tokens">
			<p className="max-w-prose text-sm text-muted-foreground">
				{m.pat_description()}
			</p>
			<Button
				className="mt-3"
				disabled={busy || loading || limitReached}
				onClick={() => changeDialog(true)}
			>
				{m.pat_create()}
			</Button>
			{limitReached && (
				<p className="mt-2 text-sm text-muted-foreground">{m.pat_limit()}</p>
			)}
			{loading ? (
				<p role="status" className="mt-4 text-sm">
					{m.app_loading()}
				</p>
			) : (
				tokens.length === 0 && (
					<p className="mt-4 text-sm text-muted-foreground">{m.pat_empty()}</p>
				)
			)}
			<PersonalAccessTokenRows
				tokens={tokens}
				busy={busy}
				onRevoke={(token) => void revoke(token)}
			/>
			{error && !open && (
				<div className="mt-3 space-y-2">
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
					<Button
						variant="outline"
						disabled={busy || loading}
						onClick={() => setRevision((value) => value + 1)}
					>
						{m.action_retry()}
					</Button>
				</div>
			)}
			<Dialog open={open} onOpenChange={changeDialog}>
				<DialogContent data-testid="pat-dialog">
					<DialogHeader>
						<DialogTitle>
							{secret ? m.pat_secret_heading() : m.pat_create()}
						</DialogTitle>
						<DialogDescription>
							{secret ? m.pat_secret_help() : m.pat_access_help()}
						</DialogDescription>
					</DialogHeader>
					{secret ? (
						<>
							<Input
								aria-label={m.pat_secret_heading()}
								value={secret}
								readOnly
								autoComplete="off"
								spellCheck={false}
								dir="ltr"
								className="font-mono"
							/>
							<Button onClick={() => void copy()}>{m.channel_copy()}</Button>
							{copyStatus && (
								<p role="status" className="text-sm">
									{copyStatus}
								</p>
							)}
							<DialogFooter>
								<Button onClick={() => changeDialog(false)}>
									{m.pat_done()}
								</Button>
							</DialogFooter>
						</>
					) : (
						<form
							className="space-y-4"
							onSubmit={(event) => {
								event.preventDefault();
								void create();
							}}
						>
							<div className="space-y-1.5">
								<label htmlFor={nameId}>{m.pat_name()}</label>
								<Input
									id={nameId}
									value={name}
									onChange={(event) => setName(event.target.value)}
									required
									maxLength={80}
									autoComplete="off"
									disabled={busy}
								/>
							</div>
							<div className="space-y-1.5">
								<label htmlFor={accessId}>{m.pat_access()}</label>
								<select
									id={accessId}
									value={access}
									onChange={(event) =>
										setAccess(event.target.value === "write" ? "write" : "read")
									}
									disabled={busy}
									className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
								>
									<option value="read">{m.pat_read()}</option>
									<option value="write">{m.pat_write()}</option>
								</select>
							</div>
							<div className="space-y-1.5">
								<label htmlFor={expiryId}>{m.pat_expiry()}</label>
								<Input
									id={expiryId}
									type="number"
									min={1}
									max={365}
									step={1}
									required
									value={expiry}
									onChange={(event) => setExpiry(event.target.value)}
									disabled={busy}
								/>
							</div>
							{error && (
								<p role="alert" className="text-sm text-destructive">
									{error}
								</p>
							)}
							<DialogFooter>
								<Button type="submit" disabled={busy || !name.trim()}>
									{m.pat_create()}
								</Button>
							</DialogFooter>
						</form>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}

export function PersonalAccessTokenRows({
	tokens,
	busy,
	onRevoke,
}: {
	tokens: PersonalAccessTokenMetadata[];
	busy: boolean;
	onRevoke: (token: PersonalAccessTokenMetadata) => void;
}) {
	const date = (value: string) =>
		new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium" }).format(
			new Date(value),
		);
	return (
		<ul className="mt-4 divide-y">
			{tokens.map((token) => {
				const status = tokenStatus(token);
				return (
					<li
						key={token.id}
						className="flex flex-wrap items-start justify-between gap-3 py-3"
					>
						<div className="min-w-0">
							<p className="break-words text-sm font-medium">{token.name}</p>
							<p className="text-sm text-muted-foreground">
								{token.access === "write" ? m.pat_write() : m.pat_read()} ·{" "}
								<span dir="ltr">…{token.hint}</span> ·{" "}
								{status === "active"
									? m.pat_active()
									: status === "expired"
										? m.pat_expired()
										: m.pat_revoked()}
							</p>
							<p className="text-xs text-muted-foreground">
								{m.pat_created({ date: date(token.createdAt) })} ·{" "}
								{m.pat_expires({ date: date(token.expiresAt) })}
							</p>
						</div>
						{!token.revokedAt && (
							<Button
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => onRevoke(token)}
								aria-label={m.pat_revoke_title({ name: token.name })}
							>
								{m.pat_revoke()}
							</Button>
						)}
					</li>
				);
			})}
		</ul>
	);
}
