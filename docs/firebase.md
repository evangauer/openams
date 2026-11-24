# Firebase deployment

An agency can host its own OpenAMS on Firebase: Firebase App Hosting serves the app,
Firebase Authentication signs people in with an emailed link (no passwords), Cloud
Firestore stores agency records and Cloud Storage holds documents. This mode is opt-in
(`AMS_AUTH_MODE=firebase`); local evaluation (`npm run dev`) is unchanged, and the
Firebase-specific code lives behind the same storage, files and sign-in interfaces
described in [architecture.md](architecture.md), so self-hosters are not tied to Google.

By default each deployment serves **one agency**: it is set up once, by the administrator
email named at install (`AMS_ADMIN_EMAIL`), and everyone else joins by invitation. To run
OpenAMS as a service for many agencies, set `AMS_SIGNUP=open`: anyone with a verified
email can then create their own agency, isolated from the others by the server-derived
tenant, with per-person, per-domain and daily limits. See [hosted identity](hosted-identity.md).

> **Before real client data.** Hosting OpenAMS makes you responsible for the nonpublic
> personal information in it. U.S. agencies are covered by the GLBA Safeguards Rule and
> state insurance data security laws (many based on the NAIC Insurance Data Security
> Model Law). If someone else runs it for you, they become a service provider you must
> oversee. Complete the [launch checklist](#launch-checklist) first. This document is
> engineering guidance, not legal advice.

## How it fits together

```
browser ──► App Hosting (Cloud Run) ─┬─ Next.js on $PORT ──► /api/* allowlist ──┐
                                      └─ OpenAMS API on 127.0.0.1 ◄──────────────┘
                                              │ Admin SDK (service account, no key files)
                                              ├─ Firebase Auth   (session cookies, revocation)
                                              ├─ Cloud Firestore (tenants/{agency}/…, identity_*)
                                              └─ Cloud Storage   (ams-documents/{agency}/…)
Cloud Scheduler ──OIDC──► /api/internal/reminders ──► API verifies token ──► due reminders
Status monitor ──OIDC──► /api/internal/status ──► health, version, counts (off by default)
```

- `apphosting.yaml` builds with `scripts/apphosting-build.mjs` (npm workspaces install + `npm run build`) and starts `scripts/firebase-start.mjs`,
  which runs the API on loopback and Next.js on `$PORT`.
- The same release can also run as a Cloud Run service from `deploy/firebase.Dockerfile`,
  including several isolated deployments in one project; see [cloud-run.md](cloud-run.md).
- `apps/api/src/firebase-server.ts` composes the Firebase adapters: Firestore records,
  Cloud Storage files, Firebase session authentication, agency membership, and the
  scheduler endpoint.

## Security model

| Control | How |
| --- | --- |
| Sign-in | Firebase email-link sign-in. The browser exchanges a fresh ID token (signed in ≤ 5 minutes ago, verified email) for an 8-hour server session cookie (`__Host-openams_session`: HttpOnly, Secure, SameSite=Lax). The client SDK keeps no persistent session. |
| Session checks | Every API request verifies the session cookie **with revocation checking**. Sign-out and member deactivation revoke the user's tokens. |
| Tenant isolation | The agency is derived on the server from the user's membership, never from the request. All records live under `tenants/{agency}`; file keys are prefixed with the agency and checked on read. |
| Authorization | Roles (`admin`, `manager`, `member`, `accountant`, `viewer`) are checked in the API for every read and write. Invitations cannot grant a role above the inviter's; the last active admin cannot be removed. |
| Direct database access | None. `firestore.rules` and `storage.rules` deny all client access; only the API (Admin SDK) reads and writes. |
| Credentials | Application Default Credentials from the App Hosting service account. No service-account key files, ever (CI rejects them). |
| Abuse controls | App Check with reCAPTCHA Enterprise is required whenever the server isn't explicitly in emulator mode (`AMS_FIREBASE_EMULATORS=1`, which also refuses `NODE_ENV=production`); Firebase email enumeration protection; agency setup limited to the install-time administrator email; a daily invitation cap; a per-user request rate limit on the records API; one export per agency at a time. |
| Request forgery | Cookie-authenticated mutations require a same-origin `Origin`/`Sec-Fetch-Site` and a JSON (or explicit binary upload) content type. |
| Browser hardening | Nonce-based Content-Security-Policy, HSTS, `frame-ancestors 'none'`, `nosniff`, Permissions-Policy, COOP. |
| Scheduler | `POST /api/internal/reminders` accepts only a Google-signed OIDC token for the configured service account with the app's own URL as audience. |
| Instance status | `GET /api/internal/status` answers 404 unless `openams-status-service-account` names a service account; then it accepts only that account's Google-signed ID tokens. It is read-only and returns health, version, the agency's name and member counts, never record contents or email addresses. See [instance-status.md](instance-status.md). |
| Logs | No record contents, tokens or email addresses in application logs. |

## Configuration

App Hosting reads these from `apphosting.yaml` and Secret Manager. Every setting marked
optional keeps the one-deployment-per-project behaviour when unset.

| Variable | Meaning |
| --- | --- |
| `AMS_AUTH_MODE` | `firebase` (set by `apphosting.yaml` and the container image). |
| `AMS_APP_URL` / `NEXT_PUBLIC_APP_URL` | The public https origin. `AMS_APP_URL` is read at runtime and wins; `NEXT_PUBLIC_APP_URL` is also inlined at build time, which is fine on App Hosting (one deployment per build). |
| `AMS_SIGNUP` | `admin` (default): one agency, set up by `AMS_ADMIN_EMAIL`. `open`: anyone can create an agency. |
| `AMS_ADMIN_EMAIL` | Administrator email(s) allowed to set up the agency (`admin` mode). |
| `AMS_ACCESS_CONTROL`, `AMS_ACCESS_SERVICE_ACCOUNT`, `AMS_ACCESS_URL`, `AMS_ACCESS_LINK_SECRET` | Optional external access control; see [external-access.md](external-access.md). |
| `AMS_AGENCY_DAILY_LIMIT`, `AMS_AGENCY_DOMAIN_DAILY_LIMIT` | Open sign-up caps per UTC day: deployment-wide (default 1000) and per email domain (default 5; large public mail providers exempt). |
| `AMS_AGENCY_REQUESTS_PER_MINUTE`, `AMS_AGENCY_WRITES_PER_DAY`, `AMS_AGENCY_STORAGE_GB` | Per-agency limits: requests per minute (default 1200), changes per UTC day (default 20000) and stored documents in GiB (default 5); see [limits.md](limits.md). |
| `AMS_SMTP_URL`, `AMS_MAIL_FROM` | Optional invitation and sign-in email through any SMTP service; see [hosted-identity.md](hosted-identity.md). Keep the URL in Secret Manager. |
| `AMS_SIGN_IN_EMAIL_DAILY_LIMIT` | Sign-in emails the deployment sends itself per UTC day (default 2000); past it Firebase sends them. |
| `AMS_SCHEDULER_SERVICE_ACCOUNT` | The only caller of the reminder endpoint. |
| `AMS_STATUS_SERVICE_ACCOUNT` | Optional status endpoint caller; `off` or unset answers 404. |
| `AMS_FIRESTORE_DATABASE` | Optional named Firestore database id (default: `(default)`). |
| `AMS_AUTH_TENANT_ID` | Optional Identity Platform tenant (default: project-level Firebase Authentication). |
| `AMS_STORAGE_BUCKET` | Bucket name. Optional on App Hosting (default: the project's Firebase bucket from `FIREBASE_CONFIG`); required elsewhere, such as Cloud Run. |
| `NEXT_PUBLIC_FIREBASE_*`, `NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY` | The project's Firebase web app and App Check key; build time. |

## Setting up a deployment

Follow the step-by-step runbook in [self-hosting.md](self-hosting.md). It's written so that a
person or an AI coding agent can complete it, with a verification step after every phase and
`npm run verify:deployment` to check the result from outside.

### Hardening (run once after setup)

These were applied and verified on a live deployment. Replace `$PROJECT`, `$BUCKET`,
`$KEY_ID` (the auto-created browser API key) and the domains with yours.

```sh
# Default compute service account: unused by App Hosting (builds and the runtime use
# firebase-app-hosting-compute). Remove its Editor grant and disable it.
gcloud projects remove-iam-policy-binding "$PROJECT" --role=roles/editor \
  --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
gcloud iam service-accounts disable "$PROJECT_NUMBER-compute@developer.gserviceaccount.com"

# Data stores
gcloud firestore databases update --database='(default)' --delete-protection
gcloud storage buckets update "gs://$BUCKET" --uniform-bucket-level-access \
  --public-access-prevention --soft-delete-duration=30d

# Browser API key: only your domains, only the APIs the web app calls
gcloud services api-keys update "$KEY_ID" \
  --allowed-referrers="https://app.example.org/*,https://$PROJECT.firebaseapp.com/*" \
  --api-target=service=identitytoolkit.googleapis.com \
  --api-target=service=securetoken.googleapis.com \
  --api-target=service=firebaseappcheck.googleapis.com \
  --api-target=service=firebaseinstallations.googleapis.com

# Logs: keep 400 days (Data Access logs land here)
gcloud logging buckets update _Default --location=global --retention-days=400
```

Also:

- **Data Access audit logs** (ADMIN_READ, DATA_READ, DATA_WRITE) for
  `datastore`, `storage`, `secretmanager` and `iam` (IAM & Admin → Audit Logs).
- **App Check enforcement** for Authentication, Cloud Firestore and Cloud Storage. Enforce
  Authentication only after confirming the deployed app obtains App Check tokens.
- **Alerts** to an owner email: Cloud Run 5xx > 10 in 5 min; log-based metrics on
  `OpenAMS API request failed` and Cloud Scheduler errors; and a billing budget with 50/90/100% thresholds.
- **Artifact Registry cleanup** on `firebaseapphosting-images` (keep 10, delete > 30 days).
- Allow Content-Security-Policy `connect-src` to `https://www.google.com/recaptcha/` (already
  in `src/proxy.ts`); reCAPTCHA Enterprise posts client signals there.

Known platform behavior: App Hosting re-grants `roles/firebase.sdkAdminServiceAgent` to the
runtime service account on each rollout, so the narrower roles above are additive rather than
exclusive. Cloud Storage soft delete (30 days) and Firestore PITR are the recovery controls
for an accidental or malicious delete. The per-user rate limiter is per instance. On a public
deployment, set `AMS_CLIENT_ADDRESS_DEPTH` so the before-authentication limits are kept per
client ([limits.md](limits.md#client-admission-limits)), and put a per-client limit (for
example Cloud Armor on a load balancer) in front.

Deploy by pushing to the connected branch, or from a checkout with
`firebase deploy --only apphosting`.

## Local development against the emulators

```sh
npm run emulators          # terminal 1: Auth, Firestore, Storage and the Emulator UI
npm run dev:firebase       # terminal 2: API + web in Firebase mode
```

`dev:firebase` sets `AMS_FIREBASE_EMULATORS=1`; without it the server refuses emulator
hosts and requires App Check. Open http://localhost:4500 (use `localhost`, not `127.0.0.1`, so the browser accepts the
`__Host-` cookie over plain HTTP). Sign-in links are printed in the emulator log and
listed at http://127.0.0.1:4000/auth. The `demo-openams` project id never reaches Google
Cloud. Adapter tests: `npm run test:firebase --workspace @openams/api` and
`npm run test:firebase-auth --workspace @openams/api`.

## Launch checklist

Engineering:

- [ ] Every phase of the [runbook](self-hosting.md), including App Check enforcement,
      email enumeration protection, PITR and scheduled backups
- [ ] A restore drill: restore a backup into a scratch database and verify records and documents
- [ ] An independent security review or penetration test of the deployed app
- [ ] Incident response runbook: who is paged, how to revoke sessions
      (`revokeRefreshTokens`) and deactivate members, and who you must notify
- [ ] Data export and deletion procedures, tested
- [ ] If you publish [hosted forms](forms.md): the bucket lifecycle rule that expires
      unsent uploads, `AMS_CLIENT_ADDRESS_DEPTH`, and a per-client rate limit at the edge

Policy (with counsel):

- [ ] Your written information security program, with OpenAMS and Google Cloud in its
      scope (GLBA Safeguards Rule, state insurance data security laws)
- [ ] If someone else runs the deployment for you: a service-provider agreement and
      your oversight of them
- [ ] Breach notification procedure that meets state timelines
- [ ] Update the README status once the above is done
