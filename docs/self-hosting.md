# Host your own OpenAMS: the runbook

This guide takes an agency from nothing to its own OpenAMS, running in a Google Cloud
project the agency owns. Your records, documents and sign-in accounts stay in that
project; nobody else, including the OpenAMS maintainers, has access to them.

**What you end up with**

- OpenAMS at your own address (for example `https://ams.youragency.example`), with
  passwordless sign-in by emailed link.
- One agency: yours. You set it up on first sign-in with the administrator email you
  choose below, then invite your team. Nobody else can sign up.
- Daily backups, 7-day point-in-time recovery, audit logs, alerts and a monthly budget.

**What it takes**: an afternoon the first time, a Google billing account, and
optionally a domain. There's no OpenAMS license fee. Google Cloud bills pay-as-you-go
for what the deployment uses, and Phase 12 sets a budget alert so you hear about
anything unexpected.

This is the currently implemented cloud deployment path. To try OpenAMS on your own
computer first, see the [README](../README.md#try-it-locally); for other hosting options
and their status, see [self-hosting options](self-hosting-options.md).

This runbook is written so that a person **or an AI coding agent** (Claude Code, Codex,
Cursor, and others) can follow it from start to finish. Every phase ends with a **Verify**
step. Steps marked **HUMAN** need you: paying, owning a domain, or deciding something that
can't be undone.

| Phase | What happens |
| --- | --- |
| [1–4](#phase-1-project-and-billing) | Create the Google Cloud project, database, file storage, sign-in and app backend |
| [5–6](#phase-5-app-check-secrets-and-accounts) | Store your settings, deploy, and set up your agency |
| [7–9](#phase-7-custom-domain-optional) | Your own domain, abuse protection and key restrictions |
| [10–13](#phase-10-reminders) | Reminders, audit logs, alerts, budget and branded sign-in emails |
| [After launch](#after-launch-your-team-and-your-book) | Invite your team, import your book, keep it updated |

> **Before real client data.** Hosting OpenAMS for an agency makes you responsible for
> nonpublic personal information under the GLBA Safeguards Rule and state insurance
> data-security laws. Finish the [launch checklist](firebase.md#launch-checklist) first.
> This runbook is engineering guidance, not legal advice.

## Using an AI agent

Clone the repository, open it in your agent, and paste:

```text
Follow docs/self-hosting.md to deploy OpenAMS to a new Google Cloud project that I own.
Work phase by phase. Run each Verify step and show me the result before moving on.
Stop and ask me at every HUMAN step and before anything that costs money or can't be undone.
Never create service-account key files, and never write secrets, keys, or my project
details into the repository, commits, issues, or pull requests.
```

Rules for the agent:

1. **Ask first** before creating the project, linking billing, choosing a region (it can't be
   changed later), changing DNS, or enforcing App Check.
2. **No key files.** Authenticate with `gcloud auth login` and
   `gcloud auth application-default login`. OpenAMS never needs a service-account key.
3. **Keep the repository generic.** Per-deployment values go in Secret Manager and
   `.firebaserc`, which git ignores. Don't commit `apphosting.local.yaml`.
4. **Verify, don't assume.** A phase is done when its Verify step passes. If one fails, stop
   and report the output.
5. **Deploy from a release.** Deploy a tagged release or `main`, not a local branch, so the
   running code matches a commit anyone can inspect.

## What you need

| Item | Notes |
| --- | --- |
| A Google account with a billing account | **HUMAN.** The Blaze (pay-as-you-go) plan is required. Set the budget in Phase 12. |
| A domain whose DNS you control | **HUMAN.** For example `app.youragency.example`. Optional at first: App Hosting gives you a `*.hosted.app` URL. |
| `gcloud`, `firebase-tools` (v15+), Node.js 24, `git` | `npm i -g firebase-tools` |
| The administrator's email address | **HUMAN.** The person who sets up the agency and invites everyone else, for example `owner@youragency.example`. They must be able to read this inbox. |

Set these once in your shell. The agent should ask you for the values marked **HUMAN**.

```sh
export PROJECT=youragency-openams        # HUMAN: globally unique and permanent
export BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX  # HUMAN: gcloud billing accounts list
export FIRESTORE_LOCATION=nam5           # HUMAN: permanent. nam5 = US multi-region
export REGION=us-central1                # App Hosting region
export BACKEND=openams
export ADMIN_EMAIL=owner@youragency.example  # HUMAN: sets up the agency on first sign-in
export ALERT_EMAIL=you@youragency.example    # HUMAN: receives alerts and budget notices
export CUSTOM_DOMAIN=app.youragency.example  # HUMAN: or leave empty for now
```

Later phases also use `API` and `H`. Re-run this whenever your token expires (about an hour):

```sh
export API="Authorization: Bearer $(gcloud auth print-access-token)"
export H="x-goog-user-project: $PROJECT"
```

## Phase 1: Project and billing

**HUMAN:** confirm the project ID, the billing account, and the Firestore location.

```sh
gcloud projects create "$PROJECT" --name="OpenAMS"   # add --organization=ORG_ID if you have one
gcloud billing projects link "$PROJECT" --billing-account="$BILLING_ACCOUNT"
gcloud config set project "$PROJECT"
gcloud services enable firebase.googleapis.com firestore.googleapis.com \
  firebasestorage.googleapis.com storage.googleapis.com firebaseapphosting.googleapis.com \
  secretmanager.googleapis.com cloudscheduler.googleapis.com recaptchaenterprise.googleapis.com \
  firebaseappcheck.googleapis.com identitytoolkit.googleapis.com cloudbuild.googleapis.com \
  run.googleapis.com artifactregistry.googleapis.com iam.googleapis.com \
  developerconnect.googleapis.com billingbudgets.googleapis.com
```

**Verify:** `gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)'`
prints `True`.

## Phase 2: Firebase, Firestore, and Storage

```sh
curl -s -X POST -H "$API" -H "$H" -H 'content-type: application/json' -d '{}' \
  "https://firebase.googleapis.com/v1beta1/projects/$PROJECT:addFirebase"
# Permissions can take a minute to propagate. If you get a 403, wait and retry.

firebase apps:create WEB "OpenAMS web" --project "$PROJECT"

gcloud firestore databases create --database='(default)' --location="$FIRESTORE_LOCATION" \
  --type=firestore-native
gcloud firestore databases update --database='(default)' --enable-pitr --delete-protection
gcloud firestore backups schedules create --database='(default)' --recurrence=daily --retention=14w

curl -s -X POST -H "$API" -H "$H" -H 'content-type: application/json' -d '{"location":"US"}' \
  "https://firebasestorage.googleapis.com/v1alpha/projects/$PROJECT/defaultBucket"
export BUCKET="$PROJECT.firebasestorage.app"
gcloud storage buckets update "gs://$BUCKET" --uniform-bucket-level-access \
  --public-access-prevention --soft-delete-duration=30d
```

**Verify:**
`gcloud firestore databases describe --database='(default)' --format='value(pointInTimeRecoveryEnablement,deleteProtectionState)'`
shows PITR and delete protection both enabled.

## Phase 3: Sign-in (email links, no passwords)

New projects must initialize Auth once. This enables Firebase Authentication with Identity
Platform, which is free for email sign-in up to 50,000 monthly users.

```sh
curl -s -X POST -H "$API" -H "$H" -H 'content-type: application/json' -d '{}' \
  "https://identitytoolkit.googleapis.com/v2/projects/$PROJECT/identityPlatform:initializeAuth"
curl -s -X PATCH -H "$API" -H "$H" -H 'content-type: application/json' \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired,emailPrivacyConfig.enableImprovedEmailPrivacy" \
  -d '{"signIn":{"email":{"enabled":true,"passwordRequired":false}},"emailPrivacyConfig":{"enableImprovedEmailPrivacy":true}}'
```

> **Known issue:** for the first few minutes after initialization, sign-in emails can contain
> a link with an empty `apiKey=`, which fails with "The selected page mode is invalid". Wait
> about five minutes and request a new link.

**Verify:** `GET .../admin/v2/projects/$PROJECT/config` shows `signIn.email.enabled: true` and
`enableImprovedEmailPrivacy: true`.

## Phase 4: App Hosting backend and least privilege

```sh
APP_ID=$(firebase apps:list WEB --project "$PROJECT" --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).result[0].appId')
firebase apphosting:backends:create --non-interactive --project "$PROJECT" \
  --backend "$BACKEND" --primary-region "$REGION" --app "$APP_ID" --root-dir /
firebase apphosting:backends:get "$BACKEND" --project "$PROJECT"   # note the hosted.app URL
export APP_URL=https://$BACKEND--$PROJECT.$REGION.hosted.app       # until the custom domain is live

SA="serviceAccount:firebase-app-hosting-compute@$PROJECT.iam.gserviceaccount.com"
for role in roles/datastore.user roles/firebaseauth.admin roles/firebaseappcheck.tokenVerifier; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="$SA" --role="$role" --condition=None
done
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="$SA" --role=roles/storage.objectCreator

# The default compute service account isn't used by App Hosting. Remove its Editor grant.
NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
gcloud projects remove-iam-policy-binding "$PROJECT" --role=roles/editor \
  --member="serviceAccount:$NUMBER-compute@developer.gserviceaccount.com" --condition=None
gcloud iam service-accounts disable "$NUMBER-compute@developer.gserviceaccount.com"
```

> **Known behavior:** App Hosting re-grants `roles/firebase.sdkAdminServiceAgent` to its
> service account on each rollout. The roles above are additive, not exclusive. Storage soft
> delete and Firestore PITR are your recovery controls.

**Verify:** `gcloud projects get-iam-policy "$PROJECT" --flatten=bindings --filter='bindings.role:roles/editor'`
returns nothing.

## Phase 5: App Check, secrets, and accounts

```sh
DOMAIN_HOST=${APP_URL#https://}
gcloud recaptcha keys create --display-name="OpenAMS web" --web --integration-type=score \
  --domains="$DOMAIN_HOST${CUSTOM_DOMAIN:+,$CUSTOM_DOMAIN}"
export SITE_KEY=<the key id printed above>
curl -s -X PATCH -H "$API" -H "$H" -H 'content-type: application/json' \
  "https://firebaseappcheck.googleapis.com/v1/projects/$PROJECT/apps/$APP_ID/recaptchaEnterpriseConfig?updateMask=siteKey" \
  -d "{\"siteKey\":\"$SITE_KEY\"}"

gcloud iam service-accounts create openams-scheduler --display-name="OpenAMS reminders (no roles)"

printf %s "$APP_URL" | firebase apphosting:secrets:set openams-public-url --data-file - --force
printf %s "$SITE_KEY" | firebase apphosting:secrets:set openams-recaptcha-site-key --data-file - --force
printf %s "openams-scheduler@$PROJECT.iam.gserviceaccount.com" | \
  firebase apphosting:secrets:set openams-scheduler-service-account --data-file - --force
# One agency, set up by your administrator ("open" would let anyone create an agency).
printf %s "admin" | firebase apphosting:secrets:set openams-signup-mode --data-file - --force
# The only address that can set up your agency. Comma-separate to allow a second person.
printf %s "$ADMIN_EMAIL" | firebase apphosting:secrets:set openams-admin-email --data-file - --force
# The read-only status endpoint stays off unless you use a monitor (docs/instance-status.md).
printf %s "off" | firebase apphosting:secrets:set openams-status-service-account --data-file - --force
firebase apphosting:secrets:grantaccess \
  openams-public-url,openams-recaptcha-site-key,openams-scheduler-service-account,openams-signup-mode,openams-admin-email,openams-status-service-account \
  --backend "$BACKEND" --location "$REGION"
```

Run the `secrets:set` commands from a scratch directory: `--force` may try to edit an
`apphosting.yaml` in the current directory. If `secrets:set` reports "An unexpected error"
after creating the secret, `grantaccess` fixes it.

**Verify:** `gcloud secrets get-iam-policy openams-public-url` lists
`firebase-app-hosting-compute`.

## Phase 6: Deploy

From a clean checkout of a release tag or `main`:

```sh
git clone https://github.com/<org>/openams && cd openams && git checkout <release-tag>
firebase deploy --only firestore,storage --project "$PROJECT"   # deny-all rules + indexes
firebase deploy --only apphosting --project "$PROJECT"          # builds in Cloud Build, ~5 min
```

**Verify:**

```sh
npm run verify:deployment -- "$APP_URL" --project "$PROJECT" --api-key "$(firebase apps:sdkconfig WEB "$APP_ID" --project "$PROJECT" | node -pe 'JSON.parse(require("fs").readFileSync(0)).apiKey')"
```

Every check must pass.

**Set up your agency (HUMAN).** Open `$APP_URL`, enter the administrator email, and open
the sign-in link from that inbox. Because it matches `openams-admin-email`, you're offered
**Set up your agency**: enter the agency's name and time zone. This happens once; after
that, the deployment never creates another agency, and anyone else who signs in is asked
to get an invitation from you.

Then check the basics: add an account, upload a file, and sign out and back in. If you'd
rather not keep test records, use obviously fictional names and delete them before your
team joins.

## Phase 7: Custom domain (optional)

```sh
curl -s -X POST -H "$API" -H "$H" -H 'content-type: application/json' -d '{}' \
  "https://firebaseapphosting.googleapis.com/v1beta/projects/$PROJECT/locations/$REGION/backends/$BACKEND/domains?domainId=$CUSTOM_DOMAIN"
curl -s -H "$API" -H "$H" \
  "https://firebaseapphosting.googleapis.com/v1beta/projects/$PROJECT/locations/$REGION/backends/$BACKEND/domains/$CUSTOM_DOMAIN" \
  | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).customDomainStatus.requiredDnsUpdates, null, 2)'
```

**HUMAN:** add the A, TXT, and `_acme-challenge` CNAME records it prints at your DNS
provider. On Cloudflare, set each to **DNS only** (grey cloud): the certificate can't be
issued through Cloudflare's proxy. Check that `dig NS yourdomain` returns the nameservers you
edited.

Add the domain to the Auth authorized domains (`PATCH .../config?updateMask=authorizedDomains`)
and to the reCAPTCHA key (`gcloud recaptcha keys update ... --domains=`).

**Verify:** the domain status reaches `HOST_ACTIVE OWNERSHIP_ACTIVE CERT_ACTIVE`, which can
take up to an hour. **Only then** switch the public URL and redeploy. The app rejects writes
from any origin other than this URL, so switching early breaks sign-in.

```sh
printf %s "https://$CUSTOM_DOMAIN" | firebase apphosting:secrets:set openams-public-url --data-file - --force
firebase deploy --only apphosting --project "$PROJECT"
export APP_URL=https://$CUSTOM_DOMAIN
```

## Phase 8: Enforce App Check

Enforce only after you've signed in successfully through the deployed app, because that
proves the app obtains App Check tokens.

```sh
for svc in identitytoolkit.googleapis.com firestore.googleapis.com firebasestorage.googleapis.com; do
  curl -s -X PATCH -H "$API" -H "$H" -H 'content-type: application/json' -d '{"enforcementMode":"ENFORCED"}' \
    "https://firebaseappcheck.googleapis.com/v1/projects/$PROJECT/services/$svc?updateMask=enforcementMode"
done
```

**Verify** after about 15 minutes, since enforcement takes time to propagate:
`npm run verify:deployment -- "$APP_URL" --project "$PROJECT" --api-key "$KEY" --expect-app-check`
passes, and you can still sign in through the browser.

## Phase 9: Lock down the browser API key

```sh
KEY_ID=$(gcloud services api-keys list --format='value(uid)' --filter='displayName~Browser')
gcloud services api-keys update "$KEY_ID" \
  --allowed-referrers="$APP_URL/*,https://$PROJECT.firebaseapp.com/*" \
  --api-target=service=identitytoolkit.googleapis.com --api-target=service=securetoken.googleapis.com \
  --api-target=service=firebaseappcheck.googleapis.com --api-target=service=firebaseinstallations.googleapis.com
```

Keep `$PROJECT.firebaseapp.com` in the list: the sign-in link handler runs there.

**Verify:** sign in again through the browser.

## Phase 10: Reminders

```sh
gcloud scheduler jobs create http openams-reminders --location="$REGION" \
  --schedule='*/10 * * * *' --http-method=POST --uri="$APP_URL/api/internal/reminders" \
  --oidc-service-account-email="openams-scheduler@$PROJECT.iam.gserviceaccount.com" \
  --oidc-token-audience="$APP_URL/api/internal/reminders" --attempt-deadline=300s
gcloud scheduler jobs run openams-reminders --location="$REGION"
```

**Verify:**
`gcloud logging read 'httpRequest.requestUrl:"/api/internal/reminders"' --freshness=15m --limit=1 --format='value(httpRequest.status)'`
prints `200`. If you change the public URL later, update `--uri` and `--oidc-token-audience`.

## Phase 11: Audit logs and retention

Enable Data Access audit logs (ADMIN_READ, DATA_READ, DATA_WRITE) for `datastore`, `storage`,
`secretmanager`, and `iam`. Edit the `auditConfigs` in `gcloud projects get-iam-policy` and
apply them with `set-iam-policy`, or use IAM & Admin → Audit Logs in the console. Then:

```sh
gcloud logging buckets update _Default --location=global --retention-days=400
```

**Verify:** `gcloud projects get-iam-policy "$PROJECT" --format='value(auditConfigs[].service)'`
lists all four services.

## Phase 12: Alerts and budget

```sh
CH=$(gcloud beta monitoring channels create --display-name="OpenAMS owner" --type=email \
  --channel-labels=email_address="$ALERT_EMAIL" --format='value(name)')
gcloud logging metrics create openams_api_errors --log-filter='resource.type="cloud_run_revision" AND textPayload:"OpenAMS API request failed"'
gcloud logging metrics create openams_scheduler_failures --log-filter='resource.type="cloud_scheduler_job" AND severity>=ERROR'
gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" --billing-project="$PROJECT" \
  --display-name="OpenAMS monthly" --budget-amount=100USD --filter-projects="projects/$PROJECT" \
  --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 \
  --notifications-rule-monitoring-notification-channels="$CH"
```

Create alert policies on the two log metrics and on Cloud Run
`run.googleapis.com/request_count` where `response_code_class="5xx"` exceeds 10 in five
minutes. Use `gcloud alpha monitoring policies create --policy-from-file`; examples are in
[firebase.md](firebase.md#hardening-run-once-after-setup).

Add a cleanup policy to the image registry so old builds don't accumulate:

```sh
gcloud artifacts repositories set-cleanup-policies firebaseapphosting-images --location="$REGION" \
  --no-dry-run --policy=<(printf '[{"name":"keep","action":{"type":"Keep"},"mostRecentVersions":{"keepCount":10}},{"name":"old","action":{"type":"Delete"},"condition":{"olderThan":"2592000s"}}]')
```

**Verify:** `gcloud alpha monitoring policies list --format='value(displayName)'` shows three
policies.

## Phase 13: Sign-in emails from your domain (optional)

By default, sign-in emails come from `noreply@$PROJECT.firebaseapp.com` with the subject
"Sign in to $PROJECT".

- In the Firebase console, go to Authentication → Templates and customize the domain. Add the
  TXT and DKIM records it gives you at your DNS provider.
- **Merge** the SPF include into your existing SPF record. A domain may have only one SPF
  record.
- Set the sender (for example `noreply@youragency.example`) and the project's public-facing
  name.
- Add a DMARC record, starting with `p=none`.

## After launch: your team and your book

**Invite your team.** Open **Team** in the sidebar and invite each person by email with a
role (administrator, manager, member, accountant or viewer; the Team page explains each).
OpenAMS doesn't send invitation emails, so tell each person your OpenAMS address. When
they sign in with the invited email, they see the invitation and join. Invitations expire
after 7 days. Make a second person an administrator so the agency never depends on one
account.

**Bring in your book.** Use **Import agency records** to load accounts, contacts,
policies, exposures, notes and tasks from CSV files exported from your current system.
Every import runs as a dry run first and shows exactly what would change; nothing is saved
until you confirm. Sample files with fictional data are in
[`apps/web/public/samples`](../apps/web/public/samples).

**Before real client data**, finish the [launch checklist](firebase.md#launch-checklist).

## Operating it

- **Updates:** deploy a newer release tag the same way as Phase 6, then run
  `verify:deployment`. Read the release notes first; they call out any new setting.
- **Backups:** PITR (7 days) and daily backups (14 weeks) are on. Run a restore drill before
  real data and every quarter after: restore into a scratch database and check the records.
- **People leaving:** deactivate them on the Team page. That signs them out everywhere
  immediately and keeps their history. The last active administrator can't be removed.
- **Incidents:** to end a person's sessions everywhere, call the Admin SDK's
  `revokeRefreshTokens(uid)`; OpenAMS checks revocation on every request.
- **Monitoring (optional):** an uptime monitor can read health and version from the
  [status endpoint](instance-status.md). It's off unless you turn it on.
- **Costs:** pay-as-you-go. The budget in Phase 12 emails you before surprises.
- **Per-agency limits:** each agency is held to a request rate, a daily number of changes
  and a document storage total. The defaults are well above normal use; to change them,
  set the variables in [limits.md](limits.md) on the backend and redeploy.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Build fails: `No workspaces found` | The buildpack rewrites `package.json`. `scripts/apphosting-build.mjs` restores the workspaces; make sure `apphosting.yaml` uses it. |
| Sign-in link: "The selected page mode is invalid" | Auth was just initialized and the link has an empty `apiKey=`. Wait five minutes and request a new link. |
| Console shows CSP errors for `www.google.com/recaptcha` | You're running an older release; upgrade. |
| Custom domain stuck on `OWNERSHIP_MISSING` | The records were added at a DNS provider that isn't authoritative, or Cloudflare proxying is on. Check `dig NS` and `dig @<authoritative-ns> A $CUSTOM_DOMAIN`. |
| Sign-in fails after enforcing App Check | Enforcement took effect before the app's domain was on the reCAPTCHA key. Add the domain, or set enforcement back to `UNENFORCED` while you fix it. |
| Saves fail with "did not originate from this workspace" | `openams-public-url` doesn't match the address in the browser. Update the secret and redeploy. |
| After signing in: "Waiting for an invitation" instead of **Set up your agency** | The address doesn't exactly match `openams-admin-email` (check spelling and `+tags`), or the agency is already set up. Fix the secret and redeploy, or ask an administrator for an invitation. |
| Rollout fails: secret `openams-admin-email` or `openams-signup-mode` not found | Upgrading from a release without it. Run the `openams-signup-mode` and `openams-admin-email` commands in Phase 5 (and `grantaccess`), then deploy again. |
