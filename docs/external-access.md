# External access control

Some deployments let an outside system decide whether each agency may use OpenAMS: a
billing system, a compliance review, an onboarding process. With
`AMS_ACCESS_CONTROL=external`, OpenAMS stores an access state per agency, enforces it on
every request, and gives agency administrators a signed link to the outside system's
page. OpenAMS doesn't know what the outside system does. It is **off by default**; a
deployment without it gives every agency full access.

## States

| State | What the agency's people can do |
| --- | --- |
| `pending` | New agencies start here. Sign in, manage the team, and (administrators) follow the link. Records are unavailable. |
| `active` | Everything. |
| `read_only` | View and export everything; changes are refused (HTTP 402, `access_read_only`). |
| `suspended` | Sign in, manage the team, and (administrators) follow the link. Records are unavailable. |

The outside system may also set a short plain-text `message` (up to 300 characters) that
the workspace shows, for example a reminder. Each change is recorded in the agency's own
audit trail (`access.changed`). A change applies at once on the instance that received it
and within 30 seconds everywhere else.

Team management (`/identity/*`: invitations, roles, deactivating members, resetting
authenticators) stays available in every state, by design. Removing someone's access must
always work, an agency that isn't `active` sends no invitation email, and anyone who joins inherits the agency's state,
so it can't be used to reach records. Uploads are checked against the state before the
file is read (`POST /ams/upload-check`), so a restricted agency can't make the server
buffer an upload it would refuse.

Endpoints only an outside system calls (this one, the status API, the reminder run)
answer 404 to any caller that isn't the configured service account, the same as when the
feature is off, so their presence isn't disclosed.

## Setting the state

`PUT /api/internal/access/v1/agencies/{agencyId}` with `{"state": "active", "message": null}`,
and `GET` on the same path to read it. Only Google-signed ID tokens for
`AMS_ACCESS_SERVICE_ACCOUNT`, with `https://<your app origin>/api/internal/access` as the
audience, are accepted; anything else gets 403. With access control off, both answer 404.
The endpoint never returns records or member details.

## The link

An agency administrator who chooses **Continue**, **Restore access** or **Manage account**
is sent to `AMS_ACCESS_URL?token=<token>`. The person who has just created an agency is
sent there once without choosing **Continue**, so setup leads straight into the outside
system's step; if they come back without finishing, the button is waiting. The token is a JWT signed with HS256 using
`AMS_ACCESS_LINK_SECRET`, valid for 10 minutes:

| Claim | Value |
| --- | --- |
| `iss` | This deployment's origin (`AMS_APP_URL`) |
| `aud` | The origin of `AMS_ACCESS_URL` |
| `sub` | The agency id (use it in the `PUT` above) |
| `name` | The agency's name |
| `uid`, `email` | The administrator who followed the link |
| `iat`, `exp`, `jti` | Issued at, expiry, unique id |

The outside system must verify the signature, `aud`, `iss` and `exp`, and should reject a
`jti` it has already seen.

## Settings

| Variable | Meaning |
| --- | --- |
| `AMS_ACCESS_CONTROL` | `external` to turn this on. Anything else (or unset): off. |
| `AMS_ACCESS_SERVICE_ACCOUNT` | The one service account allowed to read and set states. |
| `AMS_ACCESS_URL` | The outside system's https page for administrators. |
| `AMS_ACCESS_LINK_SECRET` | At least 32 random characters, shared with the outside system. Keep it in a secret manager. |

The server refuses to start if access control is on and any of these is missing. On
Firebase App Hosting, add them to `apphosting.yaml` (or an environment-specific
`apphosting.<environment>.yaml`), the secret ones as `secret:` references.

**Turning it on for an existing deployment** makes every agency `pending` until the outside
system sets a state, so set states for existing agencies first.
