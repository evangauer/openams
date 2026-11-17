# Running OpenAMS on Cloud Run

The [Firebase runbook](self-hosting.md) puts one OpenAMS deployment in its own Google
Cloud project, served by Firebase App Hosting. This page describes the alternative: a
container image you configure at runtime, run as a Cloud Run service. With it you can
run one deployment, or several isolated OpenAMS deployments in one Google Cloud project,
each serving one agency, all from the same image per release.

Everything here is optional. With none of the settings below, OpenAMS behaves exactly
as it does on App Hosting: the default Firestore database, project-level Firebase
Authentication and `NEXT_PUBLIC_APP_URL`.

> **Separate projects are the stronger boundary.** Inside one project, deployments are
> separated by per-deployment databases, buckets, sign-in tenants and service accounts,
> but some settings and administrator permissions are project-wide (see
> [caveats](#caveats)). If you can give each agency its own project, prefer that.

## What each deployment gets

| Resource | One per deployment | Why |
| --- | --- | --- |
| Cloud Run service | `openams-agency-a` | Runs the shared image with this deployment's environment. |
| Runtime service account | `openams-agency-a@PROJECT.iam.gserviceaccount.com` | The only identity that can reach this deployment's data. No key files. |
| Firestore database | `agency-a` (named, not `(default)`) | Records and identity data. |
| Cloud Storage bucket | `PROJECT-openams-agency-a` | Documents. |
| Identity Platform tenant | e.g. `agency-a-1x2y3` | Sign-in accounts. The same email in two tenants is two unrelated accounts. |
| Cloud Scheduler job | `openams-agency-a-reminders` | Calls this deployment's reminder endpoint with an OIDC token. |

Shared by every deployment in the project: the Firebase web app (API key, auth domain,
app id), the reCAPTCHA Enterprise key for App Check, and the container image.

## The image

`deploy/firebase.Dockerfile` builds every workspace and starts
`scripts/firebase-start.mjs` (the records API on loopback, Next.js on `$PORT=8080`) as
the unprivileged `node` user. The Firebase web configuration is compiled into the browser
bundle, so it is passed as build arguments; it identifies the project, is not secret and
is the same for every deployment in the project:

```sh
docker build -f deploy/firebase.Dockerfile \
  --build-arg NEXT_PUBLIC_FIREBASE_API_KEY="$WEB_API_KEY" \
  --build-arg NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN="$PROJECT.firebaseapp.com" \
  --build-arg NEXT_PUBLIC_FIREBASE_PROJECT_ID="$PROJECT" \
  --build-arg NEXT_PUBLIC_FIREBASE_APP_ID="$WEB_APP_ID" \
  --build-arg NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY="$RECAPTCHA_SITE_KEY" \
  -t "$REGION-docker.pkg.dev/$PROJECT/openams/openams:$VERSION" .
docker push "$REGION-docker.pkg.dev/$PROJECT/openams/openams:$VERSION"
```

Cloud Build or any other builder works the same way, given these build arguments. Do not pass `NEXT_PUBLIC_APP_URL` to the build: it would be baked into the image. The
repository-root `Dockerfile` is a different image, the fictional-data
[preview](hosted-preview.md).

## Runtime environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `AMS_APP_URL` | yes (or `NEXT_PUBLIC_APP_URL`) | The https origin people sign in at, e.g. `https://agency-a.example.org`. Used for the cross-site request check and as the audience of scheduler and status tokens. Read at runtime and preferred over `NEXT_PUBLIC_APP_URL`. |
| `AMS_SIGNUP` | no | `admin` (default) or `open` (anyone can create an agency). |
| `AMS_ADMIN_EMAIL` | in `admin` mode | The administrator email(s) allowed to set up this deployment's agency on first sign-in (comma separated). |
| `AMS_SCHEDULER_SERVICE_ACCOUNT` | yes | The service account whose Google-signed OIDC tokens may call the reminder endpoint. |
| `AMS_FIRESTORE_DATABASE` | for several deployments | Named Firestore database id. Unset or `(default)`: the default database. |
| `AMS_AUTH_TENANT_ID` | for several deployments | Identity Platform tenant id. Unset: project-level Firebase Authentication. The server verifies sessions against this tenant only, and the browser receives it at runtime through a `<meta name="openams-auth-tenant">` tag. |
| `AMS_STORAGE_BUCKET` | yes on Cloud Run | Cloud Storage bucket name. Only App Hosting supplies a default bucket (through `FIREBASE_CONFIG`), so the launcher refuses to start without it elsewhere. |
| `AMS_STATUS_SERVICE_ACCOUNT` | no | Enables the read-only [status endpoint](instance-status.md) for this service account. Unset or `off`: 404. |
| `AMS_CLIENT_ADDRESS_DEPTH` | on a public deployment | Where the client address is in `X-Forwarded-For`, counted from the end: `2` behind a Google Cloud external Application Load Balancer, `1` behind one reverse proxy. Unset: all clients share one admission limit; see [limits.md](limits.md#client-admission-limits). |
| `AMS_INVITATION_DAILY_LIMIT` | no | Invitations per UTC day (default 50). |
| `AMS_OPEN_SIGNUP_INVITATION_EMAILS` | no | Open sign-up without external access control: invitations one agency may have emailed per UTC day (default 5). |
| `AMS_SMTP_URL`, `AMS_MAIL_FROM` | no | Email the invitee when an invitation is created, and send sign-in links in the OpenAMS look, through any SMTP service. Keep the URL in a secret manager: it holds the password. Unset: invitations are only recorded and Firebase sends the sign-in email. |
| `AMS_SIGN_IN_EMAIL_DAILY_LIMIT` | no | Sign-in emails the deployment sends itself per UTC day (default 2000); past it Firebase sends them. |
| `AMS_AGENCY_REQUESTS_PER_MINUTE`, `AMS_AGENCY_WRITES_PER_DAY`, `AMS_AGENCY_STORAGE_GB` | no | Per-agency limits (defaults 1200 requests a minute, 20000 changes a UTC day, 5 GiB of documents); see [limits.md](limits.md). |

Set by the image, no need to pass: `AMS_AUTH_MODE=firebase`, `NODE_ENV=production`,
`PORT=8080`, and the `NEXT_PUBLIC_FIREBASE_*` / `NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY`
build arguments. Never set the emulator variables (`AMS_FIREBASE_EMULATORS`,
`*_EMULATOR_HOST`) in a deployment; the server refuses to start with them.

## Setting up a deployment

Do the project-wide parts of the [runbook](self-hosting.md) once (billing, APIs, the
Firebase web app, App Check with reCAPTCHA Enterprise, API-key restrictions, log
retention and audit logs), then upgrade the project's Firebase Authentication to
**Identity Platform** (required for tenants) and allow tenants in its settings (console:
Identity Platform > Settings).

The commands below set up one deployment, `agency-a`. Repeat with a different name for
each further deployment. Replace the placeholders with your values; keep them out of Git.

```sh
NAME=agency-a
SA="openams-$NAME@$PROJECT.iam.gserviceaccount.com"
BUCKET="$PROJECT-openams-$NAME"

# 1. Runtime service account (no keys).
gcloud iam service-accounts create "openams-$NAME" --project="$PROJECT"

# 2. Firestore database, with deletion protection and point-in-time recovery.
gcloud firestore databases create --project="$PROJECT" --database="$NAME" \
  --location="$REGION" --type=firestore-native \
  --delete-protection --enable-pitr

# 3. The fieldOverrides in apps/api/src/firebase/firestore.indexes.json: records,
#    revisions, receipts and audit store a large `value` field that must not be indexed.
for group in records revisions receipts audit; do
  gcloud firestore indexes fields update value --project="$PROJECT" --database="$NAME" \
    --collection-group="$group" --disable-indexes
done

# 4. Database access for this deployment's service account only.
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" --role=roles/datastore.user \
  --condition="expression=resource.name == 'projects/$PROJECT/databases/$NAME',title=openams-$NAME-database"

# 5. Bucket, with a bucket-level (not project-level) grant.
gcloud storage buckets create "gs://$BUCKET" --project="$PROJECT" --location="$REGION" \
  --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=30d
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$SA" --role=roles/storage.objectAdmin
```

**Security rules.** The deny-all rules in `firestore.rules` must be released for every
database (the Admin SDK ignores rules, but they stop direct browser access). With the
Firebase CLI, list each database in a `firebase.json` kept outside Git or in a separate
config file, for example:

```json
{
  "firestore": [
    { "database": "agency-a", "rules": "firestore.rules", "indexes": "apps/api/src/firebase/firestore.indexes.json" },
    { "database": "agency-b", "rules": "firestore.rules", "indexes": "apps/api/src/firebase/firestore.indexes.json" }
  ]
}
```

then `firebase deploy --project "$PROJECT" --only firestore:agency-a`. Deploying the
indexes file this way also applies the field overrides from step 3. Release
`storage.rules` (deny-all) for each bucket as well, for example with Firebase CLI deploy
targets (`firebase target:apply storage agency-a "$BUCKET"` and a `"storage"` array entry
`{ "target": "agency-a", "rules": "storage.rules" }`).

**Sign-in tenant.** Create the tenant with email-link sign-in and no passwords, and note
its generated id:

```sh
# Console: Identity Platform > Tenants > Add tenant, then Providers > Email/Password with
# "Email link (passwordless sign-in)". Or with the Admin SDK / REST API:
#   tenantManager().createTenant({ displayName: "AgencyA",
#     emailSignInConfig: { enabled: true, passwordRequired: false } })
```

Grant the runtime service account access to **this tenant only**, on the tenant's own
IAM policy (console: Identity Platform > Tenants > select the tenant > Permissions, or
the `projects.tenants.setIamPolicy` API), not on the project. See
[caveats](#caveats) for which role.

**Service and scheduler.**

```sh
gcloud run deploy "openams-$NAME" --project="$PROJECT" --region="$REGION" \
  --image="$REGION-docker.pkg.dev/$PROJECT/openams/openams:$VERSION" \
  --service-account="$SA" --allow-unauthenticated \
  --cpu=1 --memory=1Gi --concurrency=40 --min-instances=0 --max-instances=10 \
  --set-env-vars="AMS_APP_URL=https://$NAME.example.org,AMS_FIRESTORE_DATABASE=$NAME,AMS_AUTH_TENANT_ID=$TENANT_ID,AMS_STORAGE_BUCKET=$BUCKET,AMS_SCHEDULER_SERVICE_ACCOUNT=$SCHEDULER_SA,AMS_STATUS_SERVICE_ACCOUNT=off" \
  --set-secrets="AMS_ADMIN_EMAIL=openams-$NAME-admin-email:latest"

gcloud scheduler jobs create http "openams-$NAME-reminders" --project="$PROJECT" \
  --location="$REGION" --schedule="*/15 * * * *" --http-method=POST \
  --uri="https://$NAME.example.org/api/internal/reminders" \
  --oidc-service-account-email="$SCHEDULER_SA" \
  --oidc-token-audience="https://$NAME.example.org/api/internal/reminders"
```

`--allow-unauthenticated` is right: the app is public and does its own sign-in. If the
service reads a secret, grant its service account `roles/secretmanager.secretAccessor`
on that secret only. Map the custom domain (Cloud Run domain mapping or a load
balancer), and add it to Identity Platform's **authorized domains** and to the browser
API key's allowed referrers. Then check it from outside with
`npm run verify:deployment` as in the runbook, adding `--database "$NAME" --bucket
"$BUCKET"` so the direct-access checks target this deployment's resources. Without those
flags the verifier checks the default database and `${PROJECT}.firebasestorage.app`
bucket. Then sign in as `AMS_ADMIN_EMAIL`.

To upgrade, build one image for the new release and `gcloud run deploy` it to each
service; the environment stays as it is.

## Caveats

What we have checked against Google's documentation, and what we have not:

- **Database conditions.** Google documents per-database access with an IAM condition on
  `resource.name == 'projects/PROJECT_ID/databases/DATABASE_ID'` for
  `roles/datastore.user`. The Google Cloud console does not enforce these conditions;
  they apply to API and client-library access, which is what OpenAMS uses. Anyone with
  an unconditional Firestore or project-level role (Owner, Editor, Datastore Owner) can
  still read every database.
- **Tenant permissions.** Identity Platform lets you grant roles on a tenant resource,
  and documents tenant-level Viewer/Editor for account operations; creating and listing
  tenants needs the parent project. *Unverified:* which narrowest tenant-level role is
  enough for the session-cookie calls OpenAMS makes (`createSessionCookie`,
  `verifySessionCookie` with revocation check, `revokeRefreshTokens`). Test sign-in,
  sign-out and member deactivation after granting it. A project-level Firebase
  Authentication or Identity Platform admin role reaches every tenant.
- **Project-wide sign-in settings.** Tenants inherit authorized domains from the project
  (documented). The Firebase web app, its API key and referrer restrictions, the
  reCAPTCHA Enterprise key and App Check enforcement are shared by all deployments.
  Email templates and sender may be per tenant or project-wide depending on your setup;
  *unverified* here.
- **Project administrators.** Anyone with project Owner or Editor, or Firebase admin
  roles granted on the project, can read every deployment's data and sign-in accounts.
  Keep those roles to the people responsible for every agency in the project.
- **Shared quotas and logs.** API quotas, billing alerts and the `_Default` log bucket
  are per project. OpenAMS keeps record contents and email addresses out of its logs,
  but request logs from every service land in the same place.
- **App Hosting differences.** The App Hosting service agent re-grants itself broad
  SDK roles on each rollout ([firebase.md](firebase.md)); Cloud Run with your own
  service account does not, so the narrow grants above are the whole picture.
- **Not yet exercised end to end.** The named-database and tenant code paths are covered
  by the Firebase emulator tests (`npm run test:firebase-auth --workspace
  @openams/api`), not by a live multi-deployment project. Treat a first multi-deployment
  project as an evaluation and complete the [launch checklist](firebase.md#launch-checklist)
  for each deployment.
