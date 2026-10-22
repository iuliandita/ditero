# Sign-in providers

Every instance supports email/password, passkeys, TOTP and recovery codes with no
extra setup. Social and enterprise sign-in is optional, off until you configure it,
and every provider needs an OAuth client that you create for your own instance.

| Provider | Setting prefix | Verified |
| --- | --- | --- |
| [Google](#google) | `GOOGLE_` | Real service |
| [Generic OpenID Connect](#generic-openid-connect) | `DITERO_OIDC_` | Real local identity provider (Dex). The recipes for other products are not tested here. |
| [Microsoft](#microsoft) | `MICROSOFT_` | Mocked endpoints only; not yet verified against the real service |
| [GitHub](#github) | `GITHUB_` | Mocked endpoints only; not yet verified against the real service |
| [Discord](#discord) | `DISCORD_` | Mocked endpoints only; not yet verified against the real service |
| [Apple](#apple-advanced) | `APPLE_` | Mocked endpoints only; not yet verified against the real service |
| [Facebook](#facebook) | `FACEBOOK_` | Mocked endpoints only; not yet verified against the real service |

Only configured providers appear on the sign-in page. The unauthenticated
`/api/config` response lists their IDs in `socialProviders` (plus display data for
generic OpenID Connect providers in `oidcProviders`), never credentials.

SAML single sign-on for one identity provider is also optional; see
[SAML single sign-on](#saml-single-sign-on).

## Email registration

Sign-up does not sign you in. After submitting the form, sign in with your account
password when prompted. The same neutral message appears for new and existing
addresses; an existing account keeps its original password. Email verification is
optional, so an instance without SMTP remains usable. The first bootstrap account
still receives its personal workspace and owner membership. Email-bound invitees
sign in on the accept page before the invitation is redeemed; the link and any
encrypted key fragment remain available. Managed accounts retain their own
credentials and do not replace the guardian's session.

Clients calling `POST /api/auth/sign-up/email` receive `{"token":null,"user":null}`
on accepted requests, without cookies. Obtain a session and user details through
sign-in instead. Registration-policy refusals retain their existing error codes.
Provider callback refusals for account existence and registration policy use the
same neutral `PROVIDER_SIGN_IN_REFUSED` code, without a revealing description.
This does not make provider sign-in constant-time: provider responses and database
lookups can differ in duration. An allowed verified-email registration still
succeeds, so open registration and eligible invitations can reveal admission by
success versus refusal. See [Security](../security.md#authentication) for enumeration
and timing limits.

## Why each instance needs its own client

OAuth providers send the browser back only to redirect URIs registered on the
client, and the client secret has to stay on your server. A client shared by every
Ditero instance would need a central login service that sees every sign-in and
fails when it is down. Ditero does not run one, so each operator registers a client
for their own address.

## How every provider behaves

- **Callback URL.** `<BETTER_AUTH_URL>/api/auth/callback/<provider ID>`, for example
  `https://tasks.example.com/api/auth/callback/github`. It must match exactly,
  including scheme and port. The provider ID is `google`, `microsoft`, `github`,
  `discord`, `apple`, `facebook`, or the ID you chose for an OpenID Connect provider.
- **Secrets.** Every client secret accepts `NAME` or `NAME_FILE` (a file holding only
  the secret). Setting both is an error unless they hold the same value. A
  half-configured provider (an ID without its secret) stops the server at startup
  with a message naming the variable, except Google, which stays off as before.
- **Protocol.** Authorization code flow with `state`. PKCE (S256) is sent for Google,
  GitHub, Microsoft, Apple and generic OpenID Connect; Better Auth does not send it
  for Discord or Facebook, which rely on `state` and the client secret. OpenID
  Connect, Microsoft and Apple also bind the ID token to the request with a
  single-use `nonce` kept with the server-side `state`.
- **Identity.** A sign-in is recognised by the provider's immutable account ID, never
  by email: GitHub numeric ID, Discord ID, Facebook ID, Apple `sub`, Microsoft tenant
  ID plus object ID, and for OpenID Connect the issuer plus `sub`. Changing the email
  at the provider does not create a second account.
- **First sign-in is a sign-up.** Every provider, including Google and generic
  OpenID Connect, must report the email as verified before creating an account,
  in every registration mode. Then `DITERO_REGISTRATION_MODE` applies: `open`
  creates the account, `bootstrap` allows only the first account or an invited email,
  `closed` allows only invited emails. Refusals use a neutral localized message
  suggesting another sign-in method and explicit linking from Settings.
- **Invitations need a verified email.** A provider sign-in satisfies an email
  invitation only when the provider reports that email as verified (GitHub's emails
  endpoint, Discord's `verified` flag, OpenID Connect `email_verified`, Google's
  verified flag). Ditero always treats Microsoft and Facebook emails as unverified,
  so those providers cannot create accounts or satisfy invitations. Sign up with
  email or another eligible method first, then link the provider from Settings.
- **Policy outages.** If registration cannot be checked, the callback returns with
  `REGISTRATION_UNAVAILABLE` and a localized retry message. Pending native approval
  still expires normally. Concurrent duplicate provider links are refused with
  `ACCOUNT_ALREADY_LINKED`.
- **No implicit linking.** A provider account is never attached to an existing account
  because the emails match. If the account is not already linked, sign-in returns
  the neutral refusal. Sign in with another method and link the provider yourself
  (next point). This also applies to Google: earlier releases linked a Google sign-in to a password account with the same verified email;
  now you link it once under Settings.
- **Linking.** While signed in, Settings > Account lists the configured providers with
  *Link* and *Unlink* buttons. Unlink removes the selected local account row while
  retaining other sign-in methods. Linking may use a different or unverified email
  (an Apple relay address, a work account). The provider account must not already
  belong to someone else. You cannot unlink your last way to sign in. Linking happens in the browser;
  the Android and desktop apps open browser settings for it.
- **Missing email.** A provider that returns no email address (a private GitHub email
  without the `user:email` scope, a Discord account without an email, a Facebook user
  who declined) ends with a message asking to share the email or use another method.
  No account is created.
- **Native apps.** Android and desktop sign in through the system browser consent
  page, so every provider works there with the same configuration. The sign-in page
  returns to the native consent step.
- **Keep a password or passkey on the owner account.** Provider sign-in needs the
  provider to be reachable.

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

Restart the application after changing them. All other providers are configured the
same way (Compose variables, an override file, or `app.extraEnv`) and also need a
restart.

## Generic OpenID Connect

One integration covers Authentik, Keycloak, Authelia, Pocket ID, ZITADEL, Kanidm,
Entra ID, Okta and any other standards-compliant provider. Ditero reads the
provider's discovery document, then verifies every ID token's signature against the
published keys, plus its issuer, audience, expiry and nonce. The ID token is
required: a response without one is refused. The token's issuer must equal
`DITERO_OIDC_<ID>_ISSUER` character for character.

### Configure

List the providers, then configure each one. `<ID>` is the provider ID in capitals
with hyphens as underscores (`family-sso` becomes `FAMILY_SSO`).

| Variable | Required | Meaning |
| --- | --- | --- |
| `DITERO_OIDC_PROVIDERS` | yes | Comma-separated IDs: lowercase letters, digits and hyphens, starting with a letter, at most 32 characters, at most 8 providers. Reserved: `google`, `microsoft`, `github`, `discord`, `apple`, `facebook`, `credential`, `email`, `passkey`, `oauth`, `oidc`. |
| `DITERO_OIDC_<ID>_ISSUER` | yes | The issuer exactly as the provider reports it (many include a path, some a trailing slash). `https` only; `http` is accepted for loopback addresses so you can test locally. No credentials, query or fragment. |
| `DITERO_OIDC_<ID>_CLIENT_ID` | yes | |
| `DITERO_OIDC_<ID>_CLIENT_SECRET` or `_CLIENT_SECRET_FILE` | yes | |
| `DITERO_OIDC_<ID>_NAME` | no | Button label (up to 40 characters, default: the ID). |
| `DITERO_OIDC_<ID>_ICON` | no | One of `key` (default), `shield`, `building`, `users`, `server`, `cloud`. Bundled icons only; no remote images. |
| `DITERO_OIDC_<ID>_SCOPES` | no | Extra scopes, space-separated. `openid email profile` are always requested. |
| `DITERO_OIDC_<ID>_TOKEN_AUTH` | no | `basic` (default, HTTP Basic client authentication) or `post` (credentials in the request body). Use whichever the client is registered for. |
| `DITERO_OIDC_<ID>_DISCOVERY_URL` | no | Only if discovery is not at `<issuer>/.well-known/openid-configuration`. |

A typo in a `DITERO_OIDC_` variable name, or a variable for a provider that is not
listed, stops the server at startup instead of being ignored.

Example:

```sh
DITERO_OIDC_PROVIDERS=family
DITERO_OIDC_FAMILY_ISSUER=https://id.example.com/realms/home
DITERO_OIDC_FAMILY_CLIENT_ID=ditero
DITERO_OIDC_FAMILY_CLIENT_SECRET_FILE=/run/secrets/family_oidc_secret
DITERO_OIDC_FAMILY_NAME="Family login"
```

### Provider checklist

1. Create a confidential (server-side) client; note its ID and secret.
2. Register the redirect URI `<BETTER_AUTH_URL>/api/auth/callback/<ID>` exactly.
3. Allow the authorization code grant and the `openid`, `email` and `profile` scopes.
4. Make sure the provider releases `email` and `email_verified` in the ID token or at
   its userinfo endpoint. Without a verified email a new account is refused;
   an existing account holder can link it explicitly from Settings.
5. Require `S256` PKCE if the provider lets you. Ditero always sends it.
6. Note the exact issuer from the provider's discovery document.
7. Your server needs outbound HTTPS to the provider's discovery, token, userinfo and
   key endpoints; the browser needs to reach the authorization endpoint.

If the provider is down when Ditero starts, the button still appears and discovery is
retried when someone clicks it.

### Recipes

These are the settings each product's documentation points to. They were not tested
against the products themselves; only the protocol was verified (see
[Verification](#verification)).

| Product | Issuer | Notes |
| --- | --- | --- |
| Authentik | `https://auth.example.com/application/o/<slug>/` | OAuth2/OpenID provider, confidential, add the redirect URI. The issuer ends with a slash. |
| Keycloak | `https://kc.example.com/realms/<realm>` | Client authentication on, standard flow on, valid redirect URI. |
| Authelia | `https://auth.example.com` | Client using `client_secret_basic` (the default here), or set `TOKEN_AUTH=post` and register `client_secret_post`. Authelia stores a hashed secret; give Ditero the plain one. |
| Pocket ID | `https://id.example.com` | OIDC client with the callback URL; copy ID and secret. |
| ZITADEL | `https://<your-domain>` | Web application, authentication method Basic or Post, code flow. |
| Kanidm | `https://idm.example.com/oauth2/openid/<client>` | Requires PKCE (always sent); releases `email` only for groups you allow. |
| Okta | `https://<org>.okta.com` or `.../oauth2/default` | Web app, authorization code. |
| Entra ID | use [Microsoft](#microsoft) | The dedicated provider adds the tenant checks. |
| Google Workspace | use [Google](#google) | |

## Microsoft

For personal Microsoft accounts and Microsoft 365 / Entra ID work or school accounts.

### Register the app

1. In the Entra admin center, **App registrations** > **New registration**.
2. **Supported account types** decides who can attempt a sign-in; set the matching
   `MICROSOFT_TENANT` below.
3. Redirect URI, platform **Web**: `<BETTER_AUTH_URL>/api/auth/callback/microsoft`.
4. **Certificates & secrets** > **New client secret**. Copy the *value*, not the ID.
5. **Token configuration** > **Add optional claim** > *ID* > `email`, so the token
   carries an address. Work accounts without one are refused with the missing-email
   message.
6. Ditero requests only `openid profile email`, which needs no admin consent in most
   tenants. If your tenant blocks user consent, use **API permissions** > **Grant
   admin consent** for the tenant.

### Configure

```sh
MICROSOFT_CLIENT_ID=<Application (client) ID>
MICROSOFT_CLIENT_SECRET_FILE=/run/secrets/microsoft_secret
MICROSOFT_TENANT=<mode>
```

`MICROSOFT_TENANT` is required; there is no default, so you choose the audience on
purpose.

| `MICROSOFT_TENANT` | Who can sign in | App registration type |
| --- | --- | --- |
| A tenant ID (GUID) | Members and guests of that one tenant | Single tenant |
| `organizations` | Work or school accounts from any tenant | Multitenant |
| `consumers` | Personal Microsoft accounts only | Personal accounts only |
| `common` | Both | Multitenant and personal |

A domain name such as `contoso.onmicrosoft.com` is refused: Entra puts the tenant GUID
in tokens, and the check compares it. The server verifies each ID token's signature,
audience, age and nonce itself and enforces the tenant: a single-tenant app accepts only that
tenant's issuer, `organizations` rejects the personal-account tenant, `consumers`
accepts only it.

The account is keyed on tenant ID plus object ID, which Microsoft never reuses. The
email claim can change, so Ditero always treats it as unverified, including personal
accounts and tokens with `email_verified`, `verified_primary_email` or
`verified_secondary_email`. None of these claims authorizes registration or an
invitation, in any mode. People sign up with email or another eligible method first,
then explicitly link Microsoft. Tenant restrictions still apply to linking and
subsequent sign-in.

### Rotate the client secret

Microsoft caps secrets at 24 months. Before expiry: create a second secret next to the
old one, write it to the secret file, restart Ditero, check that sign-in works, then
delete the old secret. Sign-ins fail from the expiry date if you forget, so note the
date when you create the secret.

## GitHub

1. GitHub > Settings > Developer settings > **OAuth Apps** > New OAuth App.
2. Authorization callback URL: `<BETTER_AUTH_URL>/api/auth/callback/github`.
3. Generate a client secret.

```sh
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET_FILE=/run/secrets/github_secret
```

Ditero requests `read:user` and `user:email`. It uses GitHub's emails endpoint and
takes the primary address with its `verified` flag; an unverified address cannot
create an account or redeem an invitation, but can be explicitly linked. A user
with no email, or one who revoked the email scope, sees the missing-email message. The account key is the numeric user ID, so renaming
the GitHub login changes nothing.

## Discord

1. Discord developer portal > **New Application** > OAuth2.
2. Add the redirect `<BETTER_AUTH_URL>/api/auth/callback/discord`; copy the client ID
   and secret.

```sh
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET_FILE=/run/secrets/discord_secret
```

Scopes are `identify` and `email`. Discord's `verified` flag is required for
registration and invitations. Accounts without an email show the missing-email
message. The account key is the user's snowflake ID.

## Apple (advanced)

Sign in with Apple is meant for operators who already run an Apple developer account.
Ditero cannot offer a shared Apple client for all instances.

**Cost and eligibility, before you start:**

- Apple Developer Program membership, USD 99 per year.
- Apple has required an existing App Store app that uses Sign in with Apple for this
  setup; check Apple's current rules for your case.
- A **Services ID** with HTTPS return URLs on a real domain. Apple rejects IP addresses
  and `localhost`.
- A Sign in with Apple **key** (`.p8` file) with its key ID, plus your 10-character
  team ID.

### Configure

1. Create the Services ID; enable Sign in with Apple; add your domain and the return
   URL `<BETTER_AUTH_URL>/api/auth/callback/apple`.
2. Create the key (Keys > Sign in with Apple) and download the `.p8` once.
3. Mount the `.p8` read-only into the application container.

```sh
APPLE_CLIENT_ID=<Services ID, for example com.example.tasks.web>
APPLE_TEAM_ID=<10 characters>
APPLE_KEY_ID=<10 characters>
APPLE_PRIVATE_KEY_FILE=/run/secrets/AuthKey_XXXXXXXXXX.p8
```

All four are required together. The server reads the key at startup and stops with a
message if the file is missing, not a PKCS#8 key, or not an EC P-256 key.

Apple's client secret is a short-lived JWT signed with that key (ES256). Ditero creates
it itself, valid for 90 days, and makes a new one every 45 days while running,
re-reading the key file each time, so nothing is renewed by hand. Replacing the `.p8`
(for example after revoking a key) is picked up at the next renewal or on restart.

### Behavior specific to Apple

- Apple answers with a cross-site form POST to the callback. Ditero accepts Apple's
  origin only for that one route.
- Apple sends the person's name only on the first authorization.
- "Hide my email" gives a `privaterelay.appleid.com` address. It cannot match an
  invitation sent to the person's real address. The callback uses the same neutral
  refusal as other registration-policy failures. The invited person signs up with
  the invited address, then links Apple under Settings. A relay address is accepted
  when linking.
- Apple reports the email as verified, so a real address can satisfy an invitation.

## Facebook

Facebook Login for a new consumer app may require **Live** mode and advanced access
for `email`, and possibly business verification, before arbitrary users can sign in.
Meta's documentation did not settle this for new 2026 apps, so confirm in Meta's
console that your app can serve the people you expect before relying on it.

```sh
FACEBOOK_CLIENT_ID=<App ID>
FACEBOOK_CLIENT_SECRET_FILE=/run/secrets/facebook_secret
```

Redirect URI: `<BETTER_AUTH_URL>/api/auth/callback/facebook`. Scopes are
`public_profile` and `email`. Facebook's email is not a verified claim and users can
decline sharing it, so Ditero never uses it for registration or invitations. An
existing account holder can explicitly link Facebook from Settings; a user without
an email sees the missing-email message. Ditero also checks, through Facebook's
token inspection endpoint, that the access token was issued to your app.

Instagram consumer sign-in is not possible: Meta retired it in December 2024.

## Troubleshooting

The sign-in page shows these after a failed attempt.

| Message | Cause |
| --- | --- |
| Provider sign-in could not be completed | Use another sign-in method, then link the provider from Settings. New accounts require a provider-verified email and admission under the registration mode. |
| The provider did not share an email | Enable the email scope or release the email claim; see the provider section. |
| That provider account is already linked to a different account | Unlink it from the other account first. |
| Sign-in failed (generic) | Check the server log: usually a wrong secret, issuer or redirect URI, or an expired Microsoft or Apple secret. |

## Verification

- Generic OpenID Connect was driven end to end against a real Dex container
  (`ghcr.io/dexidp/dex`, pinned by digest, loopback port): discovery, S256 PKCE,
  `state`, `nonce`, signature verification, repeated sign-in on the same account, a
  wrong password, code replay, mismatched state, a wrong issuer string and a wrong
  client secret. Run it with `bunx vitest run tests/idp/oidc-dex.test.ts` (needs
  Docker).
- Every provider has automated tests against mocked token, userinfo and key endpoints,
  including the refusal cases (wrong tenant, issuer, audience, signature, expiry,
  nonce; unverified or missing email; same-email accounts). Microsoft, GitHub, Discord,
  Apple and Facebook have not been exercised against the real services.

## SAML single sign-on

One SAML 2.0 identity provider (IdP) can sign users in. Ditero uses the maintained
Better Auth SSO package for every XML and signature check; it adds no verifier of
its own. Nothing is stored for the provider: the configuration is read from the
environment at start, so there is no provider table, no admin screen and no
self-service provider registration (those routes answer 404).

### What it does and does not do

- A user is identified by the IdP's entity ID plus the NameID in the signed
  assertion, never by email. The provider ID in the callback URL is derived from the
  IdP entity ID, so another IdP can never match accounts created by this one, even
  with identical NameIDs. Request a persistent NameID (the default request does);
  a transient NameID would give a different identity on every sign-in.
- A SAML sign-in never links itself to an existing account through a matching
  email. If an account with the asserted address exists, the user returns to the
  sign-in page with an "account already exists" message and links SAML explicitly
  from Settings > Security while signed in.
- A verified domain, an email address, a SAML group or any other assertion
  attribute never grants workspace membership, ownership, a role or an encryption
  key. Joining a workspace still needs an invitation redeemed by the user, and
  workspace keys still come from an existing member. Domain verification and
  organization provisioning are off.
- A first sign-in creates an account only if `DITERO_REGISTRATION_MODE` allows it:
  `open` accepts it, `bootstrap` accepts only the first account, and `closed`
  refuses it. A refusal returns to the sign-in page with the same localized
  registration message as email sign-up. An email invitation opens the gate for a
  SAML first sign-in only if you set `DITERO_SAML_EMAIL_INVITES=true`, because the
  address in an assertion is the IdP's claim, not a verified mailbox; the invitation
  must still be redeemed. Without it, create the account from the invitation with a
  password or passkey, then link SAML.
- SAML sign-in does not ask for the local TOTP code; the IdP is the authority for
  its own multi-factor policy. Single logout is not supported: signing out of
  Ditero does not sign out of the IdP.
- Android and desktop apps sign in through the system browser, so SAML works there
  with the same configuration; see [native authentication](native-authentication.md).

### Settings

All settings are environment variables. Each one that names a secret or a document
also accepts the `_FILE` form, a path to a file inside the container; set one or the
other, never both. Empty values count as unset. Any `DITERO_SAML_*` value without an
IdP metadata source stops the server at start instead of leaving SAML silently off.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DITERO_SAML_IDP_METADATA_URL` | unset | HTTPS URL of the IdP metadata, fetched once at start with a 10-second timeout. Redirects are refused. |
| `DITERO_SAML_IDP_METADATA`, `DITERO_SAML_IDP_METADATA_FILE` | unset | The metadata XML itself, or a file holding it. Use exactly one metadata source. |
| `DITERO_SAML_SP_ENTITY_ID` | `<BETTER_AUTH_URL>/api/auth/sso/saml2/sp/metadata` | Ditero's entity ID, also the audience an assertion must name. |
| `DITERO_SAML_SP_PRIVATE_KEY`, `DITERO_SAML_SP_PRIVATE_KEY_FILE`, `DITERO_SAML_SP_CERT`, `DITERO_SAML_SP_CERT_FILE` | unset | PEM key pair, both or neither. Signs AuthnRequests when the IdP asks for signed requests, and decrypts assertions when enabled below. Start fails if the IdP asks for signed requests and there is no key pair. |
| `DITERO_SAML_ENCRYPTED_ASSERTIONS` | `false` | Expect encrypted assertions, decrypted with the key above. |
| `DITERO_SAML_NAME` | `Single sign-on` | Button label, 1-40 printable characters. |
| `DITERO_SAML_ATTRIBUTE_EMAIL`, `DITERO_SAML_ATTRIBUTE_NAME`, `DITERO_SAML_ATTRIBUTE_FIRST_NAME`, `DITERO_SAML_ATTRIBUTE_LAST_NAME` | `email`, `displayName`, `givenName`, `surname` | Assertion attribute names to read. The assertion must carry an email. |
| `DITERO_SAML_CLOCK_SKEW_SECONDS` | `60` | Tolerance for assertion times, 0-300. |
| `DITERO_SAML_ALLOW_IDP_INITIATED` | `false` | Accept responses the IdP sends without a request from Ditero. Off by default; see below. |
| `DITERO_SAML_ALLOW_DEPRECATED_ALGORITHMS` | `false` | Accept SHA-1 signatures and other deprecated algorithms. Prefer fixing the IdP. |
| `DITERO_SAML_EMAIL_INVITES` | `false` | Let a pending email invitation open the registration gate for a SAML first sign-in. |

`BETTER_AUTH_URL` must be an HTTPS origin for SAML (plain HTTP is accepted only on
loopback outside production). Compose passes every variable through; the all-in-one
image forwards the `_FILE` forms and the single-line settings, so mount key,
certificate and metadata files and point the variables at them. On Helm, mount a
Secret and set the variables under `app.extraEnv`.

### Register Ditero at the IdP

At start the server logs the entity ID, the ACS URL and the metadata URL without any
secret. The same values are available at
`<BETTER_AUTH_URL>/api/auth/sso/saml2/sp/metadata`, which any IdP that imports
metadata can use. Configure:

- Entity ID (audience): the value of `DITERO_SAML_SP_ENTITY_ID`.
- Assertion consumer service: HTTP-POST binding at
  `<BETTER_AUTH_URL>/api/auth/sso/saml2/sp/acs/saml-<hash>`. The `<hash>` is derived
  from the IdP entity ID, so a different IdP gets a different URL; copy the logged value.
- NameID format: persistent. Sign the assertion (signing only the response is not
  enough). Use RSA-SHA256 or stronger.
- Attributes: email, plus a display name, using the names above or the ones you set.

### Tested recipe: Keycloak

Verified against Keycloak 26.8 in a container (`tests/idp/saml-keycloak.test.ts`).
In the realm, create a client of type SAML:

- Client ID: the Ditero entity ID. Valid redirect URI:
  `<BETTER_AUTH_URL>/api/auth/sso/saml2/sp/acs/*`.
- Settings: Name ID format `persistent`, Force POST binding on, Sign assertions on,
  Sign documents optional, Client signature required off (turn it on only with the
  certificate from `DITERO_SAML_SP_CERT` uploaded to the client).
- The realm descriptor advertises that it wants signed AuthnRequests, and Ditero
  then refuses to start without `DITERO_SAML_SP_PRIVATE_KEY` and `DITERO_SAML_SP_CERT`
  (generate a key pair with `openssl req -x509 -newkey rsa:2048 -nodes -days 3650
  -subj /CN=ditero-sp -keyout sp.key -out sp.crt` and mount both files read-only).
- Mappers: User Property `email` to attribute `email`, `firstName` to `givenName`,
  `lastName` to `surname` (attribute name format Basic).
- Point Ditero at `https://<keycloak>/realms/<realm>/protocol/saml/descriptor`.

### What is verified on every sign-in

The signature on the assertion (a response-only signature is refused), the
issuer, the audience, the bearer recipient and the response destination, the
`NotBefore` and `NotOnOrAfter` times within the skew (assertions without times are
refused), the request correlation (`InResponseTo` must match a request issued by this
server within five minutes, used once), and one-time use of each assertion ID, which
holds under concurrent submission. Responses carrying more than one assertion, and responses over
256 KB, are refused by the verifier.

Return addresses are checked when sign-in starts and again when it ends: only the
sign-in page, `/setup`, `/settings/<section>` and `/native/authorize?grantId=...` on
this server are accepted, never another origin. Over HTTPS the browser that starts
the sign-in also receives a short-lived cookie that the callback must present, so a
response obtained by someone else cannot be delivered to another person's browser.

### IdP-initiated sign-in

Off by default. A response the IdP sends without a request from Ditero is refused,
because nothing ties it to the browser that receives it and it can be replayed from
another site. Enable `DITERO_SAML_ALLOW_IDP_INITIATED` only if the IdP offers no
SP-initiated path. Enabled responses land on `/`; the signature, audience, recipient,
time and replay checks still apply, but the browser binding cannot, so a person with
an account at the IdP could sign another person into their account.

### Certificate and key rotation

- IdP signing certificate: publish the new certificate beside the old one in the IdP
  metadata (both are trusted), restart Ditero so it reads the metadata again, then
  remove the old certificate at the IdP. Metadata is read at start only, so a changed
  URL or file takes effect after a restart. A metadata URL that is unreachable at
  start stops the server; use the file form if the IdP can be down when you restart.
- Ditero key pair: replace the files, restart, and re-import the metadata at the IdP
  before it enforces the new certificate.
- If the IdP entity ID changes, the ACS URL changes and the accounts linked through
  the old identity do not carry over; relink them from Settings > Security.

### Link and unlink

Settings > Security lists the configured provider with a link or unlink button while
signed in. Linking sends you to the IdP and back; the account that started the link
receives the identity, whatever address the IdP asserts. An identity already linked to
another account is refused. Unlink removes only the link, and the last sign-in method
of an account cannot be removed.

### Troubleshooting

Refusals reach the sign-in page as `?error=<code>` and are logged on the server
without assertion contents. Common codes: `account_not_linked` (an account with that
email exists), `REGISTRATION_DISABLED` or `REGISTRATION_INVITE_REQUIRED` (registration
policy), `invalid_saml_response` (signature, audience, recipient, time or algorithm),
`unsolicited_response` (IdP-initiated while disabled), `replay_detected`,
`invalid_state` (unknown or expired RelayState) and `sso_browser_mismatch` (the
callback came from another browser than the one that started the sign-in; start again
from Ditero in one browser). A failed start with `INVALID_RETURN_URL` means a custom
client sent a return address outside the accepted routes.

### Upgrade, backup, rollback and clients

No database migration is needed; accounts created by SAML are ordinary rows in
`account` whose `provider_id` starts with `saml-`, covered by the existing database
backup. Better Auth now runs its multi-step account writes in a database
transaction. To roll back, remove the `DITERO_SAML_*` settings or deploy the previous
image: SAML users can no longer sign in, and their rows stay inert until deleted. Give
each of those users a password or passkey before removing SAML. Web, Android and
desktop clients need no update; the button appears when the server lists a provider.

## Planned providers

| Provider | Status |
| --- | --- |
| Enterprise SAML SSO | On demand: [#1066](https://github.com/iuliandita/ditero/issues/1066) |
| Generic OpenID Connect (Authentik, Keycloak, Authelia, Pocket ID, ZITADEL, Kanidm, Entra ID, Okta, Google Workspace) | Planned first: [#1063](https://github.com/iuliandita/ditero/issues/1063) |
| Microsoft | Planned: [#1064](https://github.com/iuliandita/ditero/issues/1064) |
| GitHub, Discord | On demand: [#1065](https://github.com/iuliandita/ditero/issues/1065) |
| Enterprise SAML SSO | Available: [SAML single sign-on](#saml-single-sign-on), [#1066](https://github.com/iuliandita/ditero/issues/1066) |
| Apple | Advanced option; needs a paid Apple Developer membership and secret renewal about every six months: [#1067](https://github.com/iuliandita/ditero/issues/1067) |
| Facebook | After its app review rules are confirmed: [#1068](https://github.com/iuliandita/ditero/issues/1068) |
| Instagram | Not possible: Meta retired consumer Instagram login in December 2024. |

## Display names

Email sign-up accepts a display name; leaving it blank uses the email local part.
Change it in Settings > Account in the browser (native clients open browser settings).
Names are trimmed and limited to 1-80 characters without control characters.
Changes appear in synced member and assignee displays. Avatars are not editable.
