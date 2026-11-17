# Instance status

`GET /api/internal/status` lets something outside your deployment check that it's
healthy: an uptime monitor, or your own tooling if you run several OpenAMS deployments.
It is **off by default** and **read-only**. Nothing can be changed through it.

Each OpenAMS deployment serves one agency, and it has no admin API. Deployments are
managed through their cloud project (deploying releases, setting configuration,
scaling), not through OpenAMS.

## What it returns

```json
{
  "status": "ok",
  "version": "0.1.0",
  "revision": "openams-build-2026-11-11-000",
  "startedAt": "2026-11-11T14:02:11.000Z",
  "checkedAt": "2026-11-11T15:30:00.000Z",
  "agency": {
    "configured": true,
    "name": "Harbor Test Agency",
    "timeZone": "America/Chicago",
    "createdAt": "2026-11-11T14:20:00.000Z"
  },
  "members": { "active": 6, "total": 7 }
}
```

- `agency.configured` is `false` until the administrator sets the agency up.
- `revision` is the Cloud Run revision serving the request, or `null`.
- If Firestore can't be read, the answer is HTTP 503 with `"status": "degraded"`.

It never returns record contents, documents, correspondence or anyone's email address.

## Turning it on

The endpoint accepts only a Google-signed ID token for **one** service account that you
name, with `https://<your app origin>/api/internal/status` as the audience. Anything else
gets 403. With the secret set to `off`, it answers 404.

1. Create (or choose) the service account that will call it. It needs no roles in your
   project. If it lives in another project, only its email address matters here.
   ```sh
   gcloud iam service-accounts create openams-status --display-name="OpenAMS status reader (no roles)"
   printf %s "openams-status@$PROJECT.iam.gserviceaccount.com" | \
     firebase apphosting:secrets:set openams-status-service-account --data-file - --force
   ```
2. Redeploy. `npm run verify:deployment` reports 403 for the status check, not 404.
3. Call it with an ID token for that account:
   ```sh
   TOKEN=$(gcloud auth print-identity-token \
     --impersonate-service-account="openams-status@$PROJECT.iam.gserviceaccount.com" \
     --audiences="$APP_URL/api/internal/status" --include-email)
   curl -s -H "Authorization: Bearer $TOKEN" "$APP_URL/api/internal/status"
   ```
   Impersonation requires `roles/iam.serviceAccountTokenCreator` on that account for
   the person or system calling it.

To turn it off again, set the secret back to `off` and redeploy.

The unauthenticated `GET /healthz` on the API is loopback-only and isn't reachable from
outside the deployment.
