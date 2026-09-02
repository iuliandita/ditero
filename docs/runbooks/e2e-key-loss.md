# E2E Key Loss

Ditero has no administrator escrow and the server cannot reset attachment encryption. Treat the
encryption passphrase, recovery code, and any remembered browser as separate recovery factors.

## Lost passphrase, recovery code available

Choose **Use recovery code instead** from the unlock dialog. A valid code opens the existing
private key; it does not mint a replacement identity or orphan existing workspace grants. The flow
requires a new encryption passphrase, creates a new recovery code, invalidates the old code, and
keeps the browser unlocked after the new code is confirmed.

Save the replacement recovery code before closing the dialog. The new wraps take effect before the
code is displayed, so dismissing without recording it would leave no working copy of that factor.

## Lost passphrase and recovery code

If a remembered browser still unlocks automatically, use it immediately to download every needed
file and keep that browser profile intact until the copies are verified. The current settings flows
still require the existing passphrase to change it or generate a new recovery code; a remembered
device alone is therefore an emergency read path, not a server-side reset.

If no remembered browser can open the identity, its encrypted files are permanently unreadable.
Restoring the database, copying ciphertext from the blob store, resetting the account password, or
creating a new login cannot recreate the private key. Do not delete the remaining backup set until
you have ruled out every remembered browser profile.

## All workspace key holders are gone

Adding a new member does not recover an old workspace key. Existing files stay unreadable unless a
surviving member can open the relevant historical key version with their private key. A database
and blob restore helps only if it also restores such a membership and that person still has a
working passphrase, recovery code, or remembered browser.

Account deletion warns when the departing user is the last known holder for shared encrypted
files and requires explicit acknowledgement. This acknowledgement accepts permanent key loss; it
does not make the server capable of decrypting or re-keying the old files. A sole owner must first
transfer shared-workspace ownership, regardless of the key-loss acknowledgement.

## What rotation can and cannot do

E2E identity rotation replaces a compromised identity while the user still holds the old private
key and can rewrap every workspace key they possess. Workspace rotation after member removal stops
new uploads from using a key the removed member knows. Neither operation recovers a key that nobody
holds, revokes plaintext already downloaded, or re-encrypts historical files.

See [Security Architecture](../security.md#operator-blind-attachments) for the full trust boundary
and [Attachment Storage](attachment-storage.md) for backup-set requirements.
