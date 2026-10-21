# Sign-in providers

Every instance supports email/password, passkeys, TOTP and recovery codes with no
extra setup. Google sign-in is optional and needs an OAuth client that you create
for your own instance. Other providers are not supported yet; see
[Planned providers](#planned-providers).

## Why each instance needs its own client

OAuth providers send the browser back only to redirect URIs registered on the
client, and the client secret has to stay on your server. A client shared by every
Ditero instance would need a central login service that sees every sign-in and
fails when it is down. Ditero does not run one, so each operator registers a client
for their own address.

## Google

### Requirements

- `BETTER_AUTH_URL` is the HTTPS address your users open, on a domain under a
  public suffix (for example `tasks.example.com`). Google rejects redirect URIs on
  raw IP addresses and on private names such as `.lan` or `.local`; `localhost` is
  accepted for development only.
- The domain may resolve only inside your network or VPN. The callback is a browser
  redirect, so Google never connects to your server; your server does need outbound
  HTTPS to Google to finish sign-in. Phones need the same DNS and VPN as browsers.

### Create the client

1. In the Google Cloud console, create or pick a project and configure the OAuth
   consent screen with your app name and support email.
2. Create an OAuth client of type **Web application**.
3. Add one authorized redirect URI: `<BETTER_AUTH_URL>/api/auth/callback/google`,
   for example `https://tasks.example.com/api/auth/callback/google`. It must match
   exactly, including scheme and port.
4. Copy the client ID and client secret.

Ditero requests only the basic `openid`, `email` and `profile` scopes. Google
exempts apps limited to these scopes from the test-user list and the seven-day
token expiry of apps still in testing, so verification is not required for
ordinary sign-in.

### Configure Ditero

Set both values; Google sign-in stays off unless both are present.

- **Compose:** set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the env file, or
  mount the secret and set `GOOGLE_CLIENT_SECRET_FILE` instead of the literal secret.
- **All-in-one image:** add both to the API environment in your Compose override;
  see the [AIO guide](../../deploy/docker/aio/README.md).
- **Helm:** add both keys to a Secret and reference them from `app.extraEnv`; see
  the [chart guide](../../deploy/helm/ditero/README.md#configuration-and-operations).

Restart the application after changing them. The login and sign-up pages show
Google only when both credentials are configured. The unauthenticated `/api/config`
response publishes enabled provider names in `socialProviders`, never credentials;
web, Android and desktop browser sign-in use this same server configuration.

### Behavior

- A first Google sign-in creates an account only if `DITERO_REGISTRATION_MODE`
  would allow an email signup: in `bootstrap` mode only the first account or an
  invited email, in `closed` mode only invited emails. Invitations match the
  Google account's email address.
- Refused Google sign-ups return to the sign-in page with the same localized
  invitation-required or registration-disabled message as email sign-up.
- Google sign-in links to an existing account only when that account's email is
  verified. Sign in with your password or passkey otherwise.
- Android and desktop apps sign in through the system browser, so Google sign-in
  works there with the same configuration.
- Keep a password or passkey on the owner account. Google sign-in needs Google to
  be reachable.

## Planned providers

| Provider | Status |
| --- | --- |
| Generic OpenID Connect (Authentik, Keycloak, Authelia, Pocket ID, ZITADEL, Kanidm, Entra ID, Okta, Google Workspace) | Planned first: [#1063](https://github.com/iuliandita/ditero/issues/1063) |
| Microsoft | Planned: [#1064](https://github.com/iuliandita/ditero/issues/1064) |
| GitHub, Discord | On demand: [#1065](https://github.com/iuliandita/ditero/issues/1065) |
| Enterprise SAML SSO | On demand: [#1066](https://github.com/iuliandita/ditero/issues/1066) |
| Apple | Advanced option; needs a paid Apple Developer membership and secret renewal about every six months: [#1067](https://github.com/iuliandita/ditero/issues/1067) |
| Facebook | After its app review rules are confirmed: [#1068](https://github.com/iuliandita/ditero/issues/1068) |
| Instagram | Not possible: Meta retired consumer Instagram login in December 2024. |

New providers depend on a Better Auth upgrade,
[#1062](https://github.com/iuliandita/ditero/issues/1062).

## Display names

Email sign-up accepts a display name; leaving it blank uses the email local part.
Change it in Settings > Account in the browser (native clients open browser settings).
Names are trimmed and limited to 1-80 characters without control characters.
Changes appear in synced member and assignee displays. Avatars are not editable.
