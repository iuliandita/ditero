# Sign-in providers

Every instance supports email/password, passkeys, TOTP and recovery codes with no
extra setup. Google sign-in is optional and needs an OAuth client that you create
for your own instance. SAML single sign-on for one identity provider is optional
and configured by the operator; see [SAML single sign-on](#saml-single-sign-on).
Other providers are not supported yet; see [Planned providers](#planned-providers).

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
See [Security](../security.md#authentication) for enumeration and timing limits.

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
  Sign documents optional, Client signature required off (turn it on only together with
  `DITERO_SAML_SP_PRIVATE_KEY` and the matching certificate in the client).
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
| Generic OpenID Connect (Authentik, Keycloak, Authelia, Pocket ID, ZITADEL, Kanidm, Entra ID, Okta, Google Workspace) | Planned first: [#1063](https://github.com/iuliandita/ditero/issues/1063) |
| Microsoft | Planned: [#1064](https://github.com/iuliandita/ditero/issues/1064) |
| GitHub, Discord | On demand: [#1065](https://github.com/iuliandita/ditero/issues/1065) |
| Enterprise SAML SSO | Available: [SAML single sign-on](#saml-single-sign-on), [#1066](https://github.com/iuliandita/ditero/issues/1066) |
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
