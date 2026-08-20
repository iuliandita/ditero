// Entry for the CSP gate page in tests/e2e/crypto-vectors.spec.ts. That page is
// synthesised by Playwright with the real production header set, and
// script-src 'self' forbids an inline module -- so the import chain needs a
// file the dev server can serve. Nothing in the app imports this, so it never
// reaches a production bundle; the harness it installs is guarded regardless.
import { installCryptoVectorHarness } from "./crypto-vectors.ts";

installCryptoVectorHarness();
