# Incoming mail (pre-release)

Incoming mail connects a user's own Gmail or Microsoft 365 mailbox with read-only
permission. Both providers use the same review queue and filing workflow. This is
an optional integration scoped to the signed-in agency, including when open sign-up is enabled. It requires provider setup
and a controlled pilot before use with real agency correspondence; automated tests
and fictional-message browser checks do not verify a real provider connection.

## Connect and review

An administrator or manager connects a mailbox, chooses one Gmail label or
Microsoft folder and a starting date (UTC), then explicitly agrees to share the
selected mail with agency staff who can file correspondence. A provider grant
permits reading the mailbox; the selected folder and date restrict what OpenAMS
imports. Use a dedicated agency folder and review its contents before enabling it.

Sync is **manual**. One API request processes at most three message IDs; the screen
runs up to ten batches per click. Choose **Continue sync** if more remain. Cursors,
pending message IDs and originals are durable, so interruptions resume without
reimporting the same provider message. Gmail uses history checkpoints; Microsoft
uses folder delta checkpoints and immutable message IDs. Expired checkpoints need
a rescan. Throttling, expired consent and interrupted work remain visible.

Staff review each message, choose an account, optionally choose a policy, confirm
agency sharing and file it. The original MIME bytes and supported attachments
become immutable account documents with provider provenance. Nothing changes a
policy, sends mail, acknowledges a carrier notice, binds coverage or moves money.
Message text and sender identity are evidence to review, not proof of authority.
The preview is plain text; remote images and HTML scripts are not loaded.

Administrators, managers, members and accountants may review and file. Viewers
cannot access the incoming queue. A dismissal requires a reason and can be undone.
The history records connection, folder selection and review decisions. Uncertain
filings retain a stable command ID so the original reviewer can retry safely.
Identical originals cannot silently be filed to different accounts.

## Deployment settings

Set these **server-only** environment variables on the API process. Never commit
them or put secrets in a `NEXT_PUBLIC_` variable:

| Setting | Purpose |
| --- | --- |
| `AMS_APP_URL` | Exact public application origin, such as `https://ams.example.test`, without a trailing slash or path |
| `AMS_MAILBOX_ENCRYPTION_KEY` | Canonical base64 encoding of 32 cryptographically random bytes |
| `AMS_MAILBOX_GOOGLE_CLIENT_ID` | Gmail OAuth web application client ID |
| `AMS_MAILBOX_GOOGLE_CLIENT_SECRET` | Its client secret |
| `AMS_MAILBOX_MICROSOFT_CLIENT_ID` | Microsoft OAuth application client ID |
| `AMS_MAILBOX_MICROSOFT_CLIENT_SECRET` | Its client secret |
| `AMS_MAILBOX_MICROSOFT_TENANT_ID` | Optional directory UUID; defaults to `organizations` |

Configure either provider or both. Partial credentials fail startup. Without
credentials, the corresponding Connect button clearly shows it is unavailable.
The standard local demo launcher deliberately does not inherit these secrets.
Tests use fictional messages and injected provider responses without credentials.

Register the matching redirect URLs in each provider application:

```text
https://ams.example.test/api/mailbox/callback/gmail
https://ams.example.test/api/mailbox/callback/microsoft365
```

The authorization code flow uses PKCE, a short-lived single-use state tied to the
signed-in agency member and server-side token exchange. The callback removes its
query before making further requests. Configure request logging to exclude OAuth
callback query strings; never record authorization codes or token responses.

Gmail requests `gmail.readonly` and offline access. This is a restricted scope;
review Google's [scope and verification requirements](https://developers.google.com/workspace/gmail/api/auth/scopes)
for the intended application audience. Microsoft requests delegated `Mail.Read`,
`User.Read` and `offline_access`, using its [authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).
Tenant consent policies may require an administrator. OpenAMS does not request
mail sending, write access or application-wide mailbox access.

## Retention and recovery

Tokens are encrypted with AES-256-GCM and bound to the agency, provider and
connection. Keep the encryption key separately from database backups. Losing it
requires reconnecting; replacing the key does not migrate old grants. Disconnect
clears the local grant and stops further sync but retains imported evidence and
history. Revoke the provider application's consent separately when appropriate.

Local operational backups include encrypted connection state and queued originals,
including mail not yet filed. Restore verification checks original file hashes.
The normal agency-record export does not include this private queue or credentials.
For remote storage, back up the mailbox collections and original objects along
with the agency records, and exercise recovery with the separate encryption key.

## Current limits and checks

- Own-user Gmail and organizational Microsoft mailboxes only. Shared/delegated
  Microsoft mailboxes and national cloud endpoints are not supported.
- No background scheduler, push notifications, carrier download network or
  automatic account matching. A staff member initiates and reviews imports.
- Originals are limited to 20 MB. Filing supports at most 30 attachments;
  unsupported attachment types remain available inside the original email.
- Folder changes require an explicit replacement acknowledgment. Old queue items
  remain available; rescans do not discard previous evidence.
- A message deleted before capture cannot be recovered from the provider by
  OpenAMS. Once captured, moving or deleting provider mail does not remove it.

Run `npm run check` and `npm run test:firebase --workspace @openams/api` for local
and emulator regression coverage. Before rollout, verify consent, folder choice,
pagination, refresh, revoked access, throttling, disconnect, exact original
downloads and recovery against authorized test mailboxes for **both** providers.
