# Hosted preview

A private, hosted copy of the evaluation build so reviewers can click through OpenAMS
without running it locally. It is not a production deployment: it serves only the
fictional demo agency and a scratch test agency, keeps records in the container's
scratch disk (they reset when the instance restarts), and sends nothing to carriers,
mailboxes or payment providers.

For a demo anyone can open, where each visitor gets a private sandbox, see
[the public demo](public-demo.md). It is the same image with `AMS_PREVIEW=public`.

## How it is protected

- **Google Identity-Aware Proxy (IAP)** sits in front of the Cloud Run service. Only
  Google accounts granted `roles/iap.httpsResourceAccessor` on the service can reach it;
  everyone else gets Google's sign-in page.
- **The app checks IAP itself.** With `AMS_PREVIEW=iap`, every API request must carry a
  valid `x-goog-iap-jwt-assertion` for `AMS_PREVIEW_IAP_AUDIENCE`: an ES256 signature from
  Google's published keys, the IAP issuer, this audience, and an unexpired time window
  (`apps/web/src/lib/server/iap.ts`, tested by `apps/web/scripts/test-iap.ts`). A request
  that bypasses or outlives IAP is refused.
- **The records API never leaves the container.** It binds `127.0.0.1`; only the web app
  on `$PORT` is served.

## Run the image locally

```sh
docker build -t openams-preview .
docker run --rm -p 8080:8080 \
  -e AMS_PREVIEW_IAP_AUDIENCE=/projects/123/locations/us-central1/services/openams-preview \
  openams-preview
```

Without IAP in front, the page loads but every data request is refused, which is the
expected behavior.

## Deploy (Cloud Run with IAP)

```sh
PROJECT=<project-id>; REGION=us-central1; SERVICE=openams-preview
NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
IMAGE=$REGION-docker.pkg.dev/$PROJECT/openams/preview:$(git rev-parse --short HEAD)

gcloud builds submit --project $PROJECT --tag $IMAGE .
gcloud beta run deploy $SERVICE --project $PROJECT --region $REGION --image $IMAGE \
  --no-allow-unauthenticated --iap --max-instances 1 --memory 1Gi \
  --set-env-vars AMS_PREVIEW=iap,AMS_PREVIEW_IAP_AUDIENCE=/projects/$NUMBER/locations/$REGION/services/$SERVICE
gcloud run services add-iam-policy-binding $SERVICE --project $PROJECT --region $REGION \
  --member serviceAccount:service-$NUMBER@gcp-sa-iap.iam.gserviceaccount.com \
  --role roles/run.invoker
gcloud beta iap web add-iam-policy-binding --project $PROJECT --resource-type cloud-run \
  --service $SERVICE --region $REGION \
  --member user:<reviewer@example.com> --role roles/iap.httpsResourceAccessor
```

`--max-instances 1` keeps one SQLite file per preview. Remove access by deleting the
reviewer's IAP binding; remove the preview by deleting the service.
