import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { SignInProviderOption } from "../../../auth/provider-names.ts";
import { m } from "../../../paraglide/messages.js";
import { authClient } from "../../lib/auth-client.ts";
import { authErrorMessage } from "../../lib/auth-messages.ts";
import { fetchPublicConfig } from "../../lib/public-config.ts";
import { signInProviderOptions } from "../../lib/sign-in-providers.ts";
import { ProviderMark } from "../auth/ProviderMark.tsx";

type LinkedAccount = { id: string; providerId: string; accountId: string };

// Linking is always an explicit action by the signed-in account holder. The
// provider's email address is never compared with this account's.
export function LinkedProvidersPanel() {
	const [providers, setProviders] = useState<SignInProviderOption[]>([]);
	const [linked, setLinked] = useState<LinkedAccount[]>([]);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(() => {
		const code = new URLSearchParams(window.location.search).get("error");
		return code
			? authErrorMessage({ code }, m.account_providers_error_link)
			: null;
	});

	async function refresh() {
		const accounts = await authClient.listAccounts();
		if (accounts.error) throw new Error("accounts unavailable");
		setLinked(accounts.data ?? []);
	}

	useEffect(() => {
		let active = true;
		void Promise.all([fetchPublicConfig(), authClient.listAccounts()]).then(
			([config, accounts]) => {
				if (!active) return;
				setProviders(signInProviderOptions(config));
				if (accounts.error) setError(m.account_providers_error_load());
				else setLinked(accounts.data ?? []);
			},
			() => {
				if (active) setError(m.account_providers_error_load());
			},
		);
		return () => {
			active = false;
		};
	}, []);

	if (providers.length === 0) return null;

	async function link(provider: string) {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const here = new URL(window.location.href);
			here.searchParams.delete("error");
			here.searchParams.delete("error_description");
			const result = await authClient.linkSocial({
				provider,
				callbackURL: here.href,
				errorCallbackURL: here.href,
			});
			if (result.error)
				setError(
					authErrorMessage(result.error, m.account_providers_error_link),
				);
		} catch {
			setError(m.account_providers_error_link());
		} finally {
			setBusy(false);
		}
	}

	async function unlink(account: LinkedAccount) {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const result = await authClient.unlinkAccount({
				accountId: account.id,
			});
			if (result.error) throw new Error("unlink refused");
			setConfirming(null);
			await refresh();
		} catch {
			setError(m.account_providers_error_unlink());
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="mt-6 space-y-3" data-testid="linked-providers">
			<div>
				<h3 className="text-sm font-medium">{m.account_providers_title()}</h3>
				<p className="text-sm text-muted-foreground">
					{m.account_providers_description()}
				</p>
			</div>
			<ul className="space-y-2">
				{providers.map((provider) => {
					const account = linked.find(
						(entry) => entry.providerId === provider.id,
					);
					return (
						<li
							key={provider.id}
							data-testid={`linked-provider-${provider.id}`}
							className="flex flex-wrap items-center justify-between gap-2"
						>
							<span className="flex items-center gap-2 text-sm [&_svg]:size-4">
								<ProviderMark provider={provider} />
								{provider.name}
							</span>
							{account ? (
								<span className="flex items-center gap-2">
									<span className="text-sm text-muted-foreground">
										{m.account_providers_linked()}
									</span>
									{confirming === provider.id ? (
										<>
											<Button
												variant="destructive"
												className="pointer-coarse:h-11"
												disabled={busy}
												onClick={() => void unlink(account)}
											>
												{m.account_providers_unlink_confirm({
													provider: provider.name,
												})}
											</Button>
											<Button
												variant="outline"
												className="pointer-coarse:h-11"
												disabled={busy}
												onClick={() => setConfirming(null)}
											>
												{m.account_providers_unlink_cancel()}
											</Button>
										</>
									) : (
										<Button
											variant="outline"
											className="pointer-coarse:h-11"
											disabled={busy}
											onClick={() => setConfirming(provider.id)}
										>
											{m.account_providers_unlink({ provider: provider.name })}
										</Button>
									)}
								</span>
							) : (
								<Button
									variant="outline"
									className="pointer-coarse:h-11"
									disabled={busy}
									onClick={() => void link(provider.id)}
								>
									{m.account_providers_link({ provider: provider.name })}
								</Button>
							)}
						</li>
					);
				})}
			</ul>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
