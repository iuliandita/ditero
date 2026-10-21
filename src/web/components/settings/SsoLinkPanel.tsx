import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { m } from "../../../paraglide/messages.js";
import type { PublicSsoProvider } from "../../../server/public-config.ts";
import { authClient } from "../../lib/auth-client.ts";
import { authErrorMessage } from "../../lib/auth-messages.ts";
import { fetchPublicConfig } from "../../lib/public-config.ts";

const RETURN_PATH = "/settings/security";

// Linking is explicit: the identity provider's account never attaches itself to
// a Ditero account through a matching email, only through this signed-in action.
export function SsoLinkPanel() {
	const [providers, setProviders] = useState<PublicSsoProvider[]>([]);
	const [linked, setLinked] = useState<Set<string> | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const loadLinked = useCallback(async () => {
		const result = await authClient.listAccounts();
		if (result.error) {
			setError(authErrorMessage(result.error, m.security_sso_error_load));
			return;
		}
		setLinked(new Set(result.data.map((account) => account.providerId)));
	}, []);

	useEffect(() => {
		let active = true;
		void fetchPublicConfig().then(
			(config) => {
				if (!active || !config.ssoProviders?.length) return;
				setProviders(config.ssoProviders);
				void loadLinked().catch(() => setError(m.security_sso_error_load()));
			},
			() => {
				// Without the server list there is nothing to link.
			},
		);
		return () => {
			active = false;
		};
	}, [loadLinked]);

	if (providers.length === 0) return null;

	async function link(provider: PublicSsoProvider) {
		setBusy(true);
		setError(null);
		try {
			const result = await authClient.signIn.sso({
				providerId: provider.id,
				callbackURL: RETURN_PATH,
				errorCallbackURL: RETURN_PATH,
				fetchOptions: { query: { link: "1" } },
			});
			if (result.error)
				setError(authErrorMessage(result.error, m.security_sso_error_link));
		} catch {
			setError(m.security_sso_error_link());
		} finally {
			setBusy(false);
		}
	}

	async function unlink(provider: PublicSsoProvider) {
		setBusy(true);
		setError(null);
		try {
			const result = await authClient.unlinkAccount({
				providerId: provider.id,
			});
			if (result.error) {
				setError(authErrorMessage(result.error, m.security_sso_error_unlink));
				return;
			}
			await loadLinked();
		} catch {
			setError(m.security_sso_error_unlink());
		} finally {
			setBusy(false);
		}
	}

	return (
		<div data-testid="sso-link-panel">
			<h3 className="text-sm font-semibold">{m.security_sso_heading()}</h3>
			<p className="mt-0.5 text-sm text-muted-foreground">
				{m.security_sso_description()}
			</p>
			<ul className="mt-3 flex flex-col gap-2">
				{providers.map((provider) => {
					const isLinked = linked?.has(provider.id) === true;
					return (
						<li
							key={provider.id}
							className="flex flex-wrap items-center justify-between gap-3"
						>
							<span className="min-w-0 text-sm">
								{provider.name}
								{linked ? (
									<span className="ms-2 text-muted-foreground">
										{isLinked
											? m.security_sso_linked()
											: m.security_sso_not_linked()}
									</span>
								) : null}
							</span>
							<Button
								data-testid={isLinked ? "sso-unlink" : "sso-link"}
								variant="outline"
								className="pointer-coarse:h-11"
								disabled={busy || linked === null}
								onClick={() =>
									void (isLinked ? unlink(provider) : link(provider))
								}
							>
								{isLinked ? m.security_sso_unlink() : m.security_sso_link()}
							</Button>
						</li>
					);
				})}
			</ul>
			{error ? (
				<p role="alert" className="mt-2 text-sm text-destructive">
					{error}
				</p>
			) : null}
		</div>
	);
}
