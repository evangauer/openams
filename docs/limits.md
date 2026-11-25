# Per-agency limits

When one deployment hosts several agencies (open sign-up, `AMS_SIGNUP=open`), no agency
should be able to use a disproportionate share of it. The hosted API enforces three
protective limits for every agency. They are checked inside the agency's own requests,
keyed by the tenant taken from the signed-in person's stored membership, and they apply
in single-agency deployments too, where the defaults are far above normal use.

No endpoint reports these counters or how close an agency is to a limit, and nothing
outside an agency can read them. People see a limit only when one of their own requests
is refused.

| Setting | Default | What it limits |
| --- | --- | --- |
| `AMS_AGENCY_REQUESTS_PER_MINUTE` | `1200` | Requests one agency can make per minute, with bursts up to a minute's worth. |
| `AMS_AGENCY_WRITES_PER_DAY` | `20000` | Changes (`POST`, `PUT`, `PATCH`, `DELETE`) one agency can make per UTC day. |
| `AMS_AGENCY_STORAGE_GB` | `5` | Stored document bytes one agency can keep, in whole GiB. |

Each value must be a positive whole number. A missing or invalid value uses the default,
so a typo never removes a limit. Changes take effect when the API restarts.

## What people see

| Limit | Response | Message |
| --- | --- | --- |
| Requests | `429`, `error: "rate_limited"`, `Retry-After: 10` | Wait a few seconds and try again. |
| Daily changes | `429`, `error: "agency_quota_exceeded"`, `Retry-After` until midnight UTC | Nothing was saved; the limit resets at midnight UTC. |
| Storage | `413`, `error: "storage_quota_exceeded"` | The file was not saved. |

The existing limits still apply: each API process admits at most 5,000 agency requests and
1,000 sign-in requests a minute from one client before authentication, and each signed-in
person has a token bucket (5 requests a second, bursts of 200). The agency bucket is
charged after authentication, alongside the personal one.

## Client admission limits

The before-authentication limits are kept per client only when the deployment says where
the client's address is. Set `AMS_CLIENT_ADDRESS_DEPTH` to its position in
`X-Forwarded-For`, counted from the end: `1` behind a single reverse proxy that appends
the client address, `2` behind a Google Cloud external Application Load Balancer (which
appends the client address and then its own). Only entries your own proxies append are
trusted, so a client can't choose its key by sending its own `X-Forwarded-For`. IPv6
clients are keyed by their /64.

Unset (the default), every client shares one admission limit per API process. That is
enough for a single agency on a private network, but on a public deployment anyone can use
up the shared limit and refuse everyone's sign-in and requests until the minute ends. Set
the depth on any deployment reachable from the internet, and put a per-client limit at the
edge too (for example a Cloud Armor rate-limiting rule on the load balancer).

The scheduler's reminder endpoint counts requests per client before checking the
scheduler's signed token, and charges the scheduler's own allowance only after it, so
requests from anyone else never use up the scheduler's admission.

## Invitation email

With open sign-up and no [external access control](external-access.md), nobody vets a new
agency before it can invite people. Each agency's first 5 invitations a UTC day are
emailed (`AMS_OPEN_SIGNUP_INVITATION_EMAILS`); later ones are recorded and the inviter is
shown the invitation link to send themselves. With external access control, only an active
agency's invitations are emailed. In single-agency deployments every invitation is emailed,
up to the daily invitation limit.

## Sign-in email

When the deployment sends sign-in links itself (`AMS_SMTP_URL`, see
[hosted-identity.md](hosted-identity.md)), each API process allows 20 requests a minute per
client, 3 links per mailbox with one more every 10 minutes (aliases of one inbox count
together), and `AMS_SIGN_IN_EMAIL_DAILY_LIMIT` links per UTC day across the deployment
(default 2000). Past the request, mailbox or daily allowance, or if sending fails, the browser asks
Firebase to send its built-in email instead, so nobody can stop sign-in by using up the
allowance. The API logs `OpenAMS sign-in emails today reached AMS_SIGN_IN_EMAIL_DAILY_LIMIT`
the first time a day's allowance runs out.

## How they work, and the trade-offs

- **Requests** use an in-memory token bucket per agency in each API process. With several
  instances, the effective ceiling is the setting times the number of instances, the
  same as the per-person buckets. Treat it as a bound on what one agency can make one
  instance do, not an exact global rate.
- **Daily changes** are counted in a durable, transactional counter per agency per UTC
  day, stored with the other sign-up and invitation limit counters (never with agency
  records, and never readable through the API). A transaction for every change would
  double the database work of every save, so each process instead reserves a block of 25
  changes in one transaction and spends it locally. The cost is about one extra
  transaction per 25 changes. Reserved changes that an instance does not use (for
  example because it restarts or the day ends) still count, so an agency can be refused
  up to 25 changes per instance before reaching the exact limit. The check runs after
  external access control, so a refused change does not use up the quota. Background
  polling sent as `POST` (team chat presence and read markers, import validation) is not
  counted; the request limit bounds it. One request counts once, so an import that adds
  many records is one change.
- **Storage** is a durable counter of document bytes per agency. Bytes are reserved in a
  transaction before a new object is written, and released if the write does not create
  one (an identical retry, or a failed write). Documents are archived rather than
  deleted, so archived documents keep counting. Files stored before this limit existed
  are not counted. Uploads that the web app forwards are at most 20 MB each.

Local evaluation (SQLite and local files) does not enforce these limits.
