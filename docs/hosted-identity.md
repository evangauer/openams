# Hosted identity (Firebase email-link and optional text sign-in)

Opt-in with `AMS_AUTH_MODE=firebase` in **both** the web and API processes. Leave it
unset and OpenAMS runs the local evaluation exactly as before (local test roles,
fictional demo). In firebase mode `/api/agency/local-session` and `demo/start` return
404, `localAmsEnabled()` is false, and `apps/api/src/local-server.ts` refuses to start.

## Flow

1. The person enters an email. With mail settings (see Sign-in email below) the API
   emails the link itself; otherwise, or whenever it declines, the browser calls Firebase
   `sendSignInLinkToEmail` (`handleCodeInApp: true`, return URL `<origin>/sign-in/finish`).
   The email is kept in `localStorage` only so the same browser can finish without
   retyping.
2. `/sign-in/finish` completes the link with `signInWithEmailLink`. If the email is not
   remembered (another device or browser), the person must type it; a link sent to a
   different address then fails, which prevents session fixation. The page sends
   `Referrer-Policy: no-referrer` because the URL carries a one-time code.
3. The client takes one ID token, POSTs it to `/api/auth/session` (plus
   `X-Firebase-AppCheck` when App Check is configured) and signs the client SDK out.
   Client persistence is `inMemoryPersistence`; the server cookie is the session.
4. The web route forwards to API `POST /identity/session`, which verifies the token
   with the revocation check, requires `email_verified` and `auth_time` within 5
   minutes, and mints an 8-hour Firebase session cookie. The web route stores it as
   `__Host-openams_session` (HttpOnly, Secure, SameSite=Lax, Path=/). The API never sets
   cookies.
5. Every `/ams/*` and `/identity/*` request forwards the cookie as
   `Authorization: Bearer`. The API calls `verifySessionCookie(cookie, true)` and loads
   the membership. The tenant always comes from the stored membership.
   With `AMS_REQUIRE_MFA` on, the session is minted only from a sign-in that used a
   second factor, and every request re-checks it (see Two-step sign-in below).
6. No membership: accept a pending invitation, or create an agency. Who may create one
   depends on `AMS_SIGNUP`: in `admin` mode (default) only the administrator email named at
   install (`AMS_ADMIN_EMAIL`), once, while the deployment has no agency; in `open` mode
   anyone with a verified email, within the limits below.

## API (`apps/api/src/firebase/identity.ts`)

`createFirebaseAuthenticate`, `createIdentityRouter`, `firestoreMembers`,
`firestoreWorkspaceName`, `firestoreTimeZone`. Instances of Auth, Firestore and App
Check are injected; the module never calls `initializeApp`.

| Endpoint | Who | Notes |
| --- | --- | --- |
| `POST /identity/session` | anyone with a fresh ID token | App Check enforced when an `AppCheck` instance is passed |
| `POST /identity/sign-in-link` | anyone | `{ sent: true }` when the deployment emailed the link, `{ sent: false }` to use Firebase's email; App Check as above |
| `POST /identity/sign-out` | session | `revokeRefreshTokens` (signs out every device) |
| `GET /identity/me` | session | membership, pending invitations for the verified email, and `setupAvailable` |
| `POST /identity/agencies` | no membership; `admin` mode: `AMS_ADMIN_EMAIL` and no agency yet; `open` mode: anyone within limits | tenant id `agency_` + 24 random URL-safe chars |
| `GET/POST /identity/invitations`, `POST /identity/invitations/:id/revoke` | admin, manager | |
| `POST /identity/invitations/accept` | session, no membership | verified email must equal the invited email |
| `GET /identity/members` | any active member | |
| `POST /identity/members/:uid/role\|deactivate\|reactivate` | admin; manager for non-admins | last-admin protection |

### Firestore layout (owned here)

- `identity_users/{uid}`: `email`, `tenantId | null`
- `identity_agencies/{tenantId}`: `name`, `timeZone`, `createdBy`, `createdAt`
- `identity_agencies/{tenantId}/members/{uid}`: `role`, `name`, `email`, `active`, timestamps
- `identity_invitations/{id}`: `tenantId`, `email`, `role`, `status`, `invitedBy`, `createdAt`, `expiresAt` (+ accepted/revoked fields)
- `identity_limits/{instance_agency | invitations_<tenant>_<day>}`: `instance_agency` is
  created with the agency, so a second setup fails even when two requests race
- `tenants/{tenantId}/identity_audit/{auto}`: actor, action, target, before/after role and active

Membership writes (agency creation, acceptance, role change, deactivation) update
`identity_users` and `members` in one Firestore transaction, together with the limit
counters and the audit entry. Mutations re-read the acting member inside the
transaction, so a concurrent demotion is honored. Clients should have **no** direct
Firestore access to these collections; deny them in security rules.

### Decisions to review

- **No invitation token.** Firebase email-link sign-in proves control of the address,
  and acceptance requires the verified email to equal the invited one. A bearer token
  would add a leakable credential without adding proof. The invitation id is random but
  is not a credential; a wrong email gets the same 404 as a missing invitation.
- **Invitation email is optional and off by default.** Without mail settings the UI says
  "Invitation recorded; no email was sent" and the inviter copies the sign-in steps to
  send themselves. With `AMS_SMTP_URL` and `AMS_MAIL_FROM` set (any SMTP service), the
  invitee is emailed who invited them, to which agency and role, and where to sign in.
  The message carries no token and its only link is the app's own address. The agency's
  name is cut to one short line with links and markup removed, because the agency
  chose both that name and the recipient. With external access control on, only an
  `active` agency sends mail. If the send fails, the invitation still stands and the
  inviter is told no email went out.
- **Sign-in email is optional too.** Firebase's built-in sign-in email can't be restyled:
  its text is fixed, it comes from `noreply@<project>.firebaseapp.com` unless the console
  sets a custom domain, and its link goes through Firebase's action page. With
  `AMS_SMTP_URL`, `AMS_MAIL_FROM` and the app URL set, `POST /identity/sign-in-link` asks
  Firebase for the same one-time link (`generateSignInWithEmailLink`), points it straight
  at this app's `/sign-in/finish` with the same code, and mails it in the OpenAMS look
  (`apps/api/src/firebase/sign-in-mail.ts`). It answers `{ sent: false }`, and the browser
  falls back to Firebase's email, when mail isn't configured, the mailbox has had 3 links
  lately (aliases count as one inbox; one more every 10 minutes, per API process), the
  deployment has sent `AMS_SIGN_IN_EMAIL_DAILY_LIMIT` today (default 2000), or sending
  fails. The answer never depends on whether the address has an account, and sign-in
  keeps working when the mail service is down. Its images come from the app's own origin
  (`/brand/email/`); with images blocked, the email still reads.
- **One membership per user (v1).** A deactivated member keeps their membership and
  cannot create or join another agency until an administrator reactivates them.
- **`admin` mode: one agency per deployment.** Only an address listed in
  `AMS_ADMIN_EMAIL` (exact match after lowercasing; `+tag` aliases are different
  addresses) can set up the agency, and only while none exists. Anyone else who signs in
  is asked to get an invitation. With `AMS_ADMIN_EMAIL` unset, nobody can set up an agency.
- **`open` mode: one agency per uid and per mailbox, ever.** Aliases of one inbox (`+tags`,
  and dots for Gmail) count as one mailbox. Each email domain may create
  `AMS_AGENCY_DOMAIN_DAILY_LIMIT` agencies per UTC day (default 5; large public mail
  providers are exempt). A deployment-wide backstop (`AMS_AGENCY_DAILY_LIMIT`, default
  1000) pauses sign-up, and the API logs `OpenAMS agency sign-ups today` once half of it is
  used so you can alert on it. Every agency is isolated by the tenant taken from the
  stored membership; App Check is required outside the emulators.
- Invitations are capped per agency per day (`AMS_INVITATION_DAILY_LIMIT`, default 50).
- **Invitations show who sent them** (the inviter's email) and when the agency was
  created, with a prompt to join only an agency the invitee recognizes.
- **Members cannot deactivate themselves**; admins can demote themselves only while
  another active admin exists.
- **Sign-out revokes all of the person's sessions**, because Firebase revocation is per
  user.

## Links that prefill sign-in and setup

A page that introduces OpenAMS (your own website, an onboarding email) can link into the
app with values the visitor already gave, so they don't type them twice:

`https://<your app>/?agency=Harbor%20Agency&email=sam%40harbor.example&scheme=dusk`

| Parameter | Prefills |
| --- | --- |
| `agency` | The agency name on the create-agency form (up to 120 characters) |
| `email` | The address on the sign-in form |
| `scheme` | The color scheme (an id from Settings → Appearance) |

These are suggestions only: the person still reviews and submits each form, and nothing
is created from the link itself. `agency` and `email` are removed from the address bar at
once, kept in the browser's storage for up to a day (sign-in finishes from the emailed
link, often in another tab), and cleared when the agency is created
(`apps/web/src/features/agency/setup-suggestion.ts`). Malformed or oversized values are
ignored. Don't put anything secret in such a link. The suggested agency name is shown only
in the name field of the create-agency form, after sign-in; it is never echoed on the
sign-in page, so a crafted link can't put its own words there.

## Terms at agency creation (`AMS_TERMS_URL`, `AMS_TERMS_VERSION`)

Optional; set both or neither. When set, the agency setup form shows "I agree to the
terms on behalf of this agency" linking to `AMS_TERMS_URL`, and `POST /identity/agencies`
requires `acceptTerms` equal to `AMS_TERMS_VERSION` (400 `terms_required` otherwise, with
a "the terms have changed" message for an older version). The agency document records
`termsAccepted: { version, uid, email, at }`. `/identity/me` returns `terms`. The URL must
be https; the version may contain letters, digits and `.;@_:+-`. A malformed value stops
the API from starting rather than silently dropping the requirement.

## Two-step sign-in (`AMS_REQUIRE_MFA`)

Off by default. With `AMS_REQUIRE_MFA=1`, everyone finishes sign-in with a code from an
authenticator app (TOTP) after the email link. Agencies that keep clients' nonpublic
personal information generally need this (for example, the FTC Safeguards Rule requires
multi-factor authentication for anyone accessing customer information).

- **First sign-in:** after the email link, `POST /identity/session` answers 403
  `mfa_enrollment_required`. The finish page shows a QR code (and the key, for typing
  in), the person enters the app's code, the factor is enrolled with Firebase's TOTP
  support, and the session is created.
- **Later sign-ins:** completing the email link requires the second factor
  (`auth/multi-factor-auth-required`); the page asks for the code, then creates the session.
- **Enforcement:** `POST /identity/session` refuses a token without
  `firebase.sign_in_second_factor`, and every `/identity/*` and `/ams/*` request checks the
  session cookie for it too. Turning the setting on ends sessions created without a
  second factor at their next request.
- **Lost phone:** an administrator uses **Reset authenticator** on the Team page
  (`POST /identity/members/{uid}/reset-mfa`, admins only, not for themselves). It clears
  the member's factors, signs out their sessions and records `member.mfa_reset` in the
  agency's audit trail; they set up a new app at their next sign-in. If an agency's only
  administrator loses theirs, whoever runs the deployment clears it with the Firebase
  Admin SDK (`updateUser(uid, { multiFactor: { enrolledFactors: null } })`).
- Administrators and managers see who has set up an authenticator on the Team page.

Turn on TOTP in Identity Platform before setting `AMS_REQUIRE_MFA`:

```sh
curl -X PATCH -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "x-goog-user-project: <project>" -H "Content-Type: application/json" \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/<project>/config?updateMask=mfa" \
  -d '{"mfa":{"providerConfigs":[{"state":"ENABLED","totpProviderConfig":{"adjacentIntervals":5}}]}}'
```

## Deploy checklist (console settings, not code)

- Authentication > Sign-in method: enable **Email link (passwordless)**. Add Phone only
  when opting into text sign-in below.
- Authentication > Settings: enable **Email enumeration protection**.
- Authentication > Settings > Authorized domains: only the production host(s).
- App Check with reCAPTCHA Enterprise; pass `appCheck` to `createIdentityRouter` and set
  `NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY`.
- Firestore rules deny client access to the collections above.
- Keep `AMS_API_URL` on loopback; the API is not exposed publicly.

## Local development and tests

`__Host-` cookies require `Secure`. Chrome and Firefox accept Secure cookies over
plain `http://localhost` (treated as a secure context); Safari does not. Run the web
app on **`http://localhost:<port>`** (not `127.0.0.1`) when testing against the
emulators, set `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9299`, and copy the
sign-in link from the emulator log (the emulator does not send email).

```sh
# Requires firebase-tools and Java 21 on PATH.
npm run test:firebase-auth --workspace @openams/api
```

The emulator config is `apps/api/tests/firebase-auth/firebase.emulators.json`
(project `demo-openams-auth`, auth 9299, firestore 8282). For manual browser testing,
`apps/api/tests/firebase-auth/emulator-server.mjs` composes the routers against the
emulators; it refuses to run without emulator hosts.

## Request admission limits

Each API process caps identity requests at 1,000 per minute, agency requests at
5,000 per minute, and each internal reminder route at ten per minute, before
authentication or expensive work. These aggregate in-memory limits protect one
process; they are not a distributed denial-of-service defense. Per-agency request,
change and storage limits are described in [limits.md](limits.md).
Forwarded IP headers cannot change the key. The existing signed-in per-user token
buckets still apply after authentication. Rejected requests return 429 with
`Retry-After`; clients should wait before retrying. Size the deployment and verify
these limits with representative simultaneous-user traffic before production use.

## Optional text sign-in (`AMS_SMS_SIGNIN`)

Off by default. Set `AMS_SMS_SIGNIN=1` in both web and API processes to offer a texted
code as an alternative to the email link. It is disabled when `AMS_REQUIRE_MFA` is on;
SMS here is a primary sign-in method, not a second factor. It also stays disabled when
`AMS_AUTH_TENANT_ID` is set: Identity Platform tenants do not support primary Phone
sign-in (`UNSUPPORTED_TENANT_OPERATION`). Use project-level Firebase Auth in an isolated
project for a deployment that needs this method. Phone MFA is a different feature.
The Auth emulator does not establish support for a provider in the hosted service.

Users first prove their email with an email link. On the sign-in screen, **Add or change
text sign-in** sends a fresh email link, then lets the user verify and link a mobile
number to that same Firebase UID. It never merges accounts. A number already linked to
another user is refused. Later, either an email link or a text code reaches the same
membership; the server never looks up agency access using a submitted number.

A phone-only Firebase identity cannot mint an application session. If Firebase creates
an empty identity during an unlinked number's first sign-in, the browser removes only
that newly-created identity and directs the user to email sign-in. The API still rejects
such identities independently of browser behavior.

The same fresh-email flow lets the user replace or remove their linked number. Each
SMS-authenticated request checks the current Firebase phone binding, so an old SMS
session stops working when its number is removed or replaced. Email sign-in remains
available for recovery. Administrators should deactivate lost or compromised accounts
through the existing team controls as appropriate.

Before enabling this setting:

- Enable the Phone sign-in provider in the deployment's Firebase project, set the
  intended SMS region policy and quotas, and authorize the app domain. Keep production
  and test identities in separate projects; do not reuse a production user pool just
  to work around the tenant limitation.
- Configure the app's display name for the verification message. Firebase controls the
  sending number. The UI obtains consent before requesting a text and explains Google's
  authentication/abuse-prevention processing and possible message charges.
- Test reCAPTCHA, actual delivery, retries, quotas and account recovery. Emulator tests
  prove identity/session behavior; they do not prove carrier delivery.

Existing authenticator enrollment is not silently removed by changing a setting.
Firebase may still ask for that factor. After a fresh email sign-in and the existing
factor challenge, **Add or change text sign-in** offers **Remove authenticator app**
when this optional single-step mode is enabled. The user signs in again after removing
it. Someone who has lost the authenticator uses the existing administrator reset flow.

The sign-in SDK keeps its user in memory only while finishing the link or changing the
phone binding, then signs out after exchanging a fresh ID token for the server cookie.
No SMS code or phone number is written to browser storage. Firebase's app-verification
bypass is set only when the explicitly configured Auth emulator is used.

References: [Firebase phone sign-in](https://firebase.google.com/docs/auth/web/phone-auth), [account linking](https://firebase.google.com/docs/auth/web/account-linking),
[SMS region policies](https://docs.cloud.google.com/identity-platform/docs/admin/sms-regions),
and [tenant-supported sign-in methods](https://docs.cloud.google.com/identity-platform/docs/multi-tenancy-managing-tenants#supported_features).
