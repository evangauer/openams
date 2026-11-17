# Public demo

A hosted copy of the evaluation build that anyone can open without signing in. Each
browser gets its **own private sandbox**: a copy of the fictional demo agency that only
that visitor can see and change, deleted after a day. It is the same image as the
[hosted preview](hosted-preview.md), started with `AMS_PREVIEW=public`.

It is not a production deployment. It holds fictional records only, sends nothing to
carriers, mailboxes or payment providers, and forgets everything when it restarts.

## What a visitor gets

- Opening the address goes straight into the demo agency as its administrator. There is
  no form and no role to choose.
- A banner says the records are fictional, asks visitors not to enter real client
  information, and offers **Fresh demo** (delete this copy, start another).
- Optionally, one link onward in the banner, for example to the page where a visitor can
  get OpenAMS for their own agency (`AMS_DEMO_LINK_URL`).

## How visitors are kept apart

- The web app gives each browser a random 256-bit token in an `HttpOnly`, `Secure`,
  `SameSite=Strict` cookie scoped to the API path. The token is the only thing that
  opens a sandbox; the tenant id is derived from it and never accepted from the client.
- The records API binds `127.0.0.1` inside the container. It accepts sandbox tokens and
  nothing else: the local test roles and the scratch agency of the evaluation build do
  not exist in this mode (`/api/agency/local-session` and `demo/start` answer 404).
- Every read and write is scoped to the sandbox's tenant by the same checks that separate
  agencies everywhere else in OpenAMS.

## What is turned off or bounded

| | |
| --- | --- |
| File uploads | Refused (403, "turned off in the public demo"). The disk is shared scratch space. |
| Mailboxes | Not offered; the demo connects to no mailbox. |
| Lifetime | `AMS_DEMO_HOURS` (default 24). Then the sandbox's records, history, chat and files are deleted. |
| Sandboxes alive at once | `AMS_DEMO_MAX_SANDBOXES` (default 200). At the cap, a sandbox idle for 15 minutes makes room; otherwise new visitors are asked to try again shortly (429). |
| New sandboxes | `AMS_DEMO_STARTS_PER_MINUTE` (default 30), across all visitors. |
| Per sandbox | 600 requests a minute, and 3,000 changes over its life (429 after that; **Fresh demo** starts again). |
| Search engines | Every response carries `X-Robots-Tag: noindex, nofollow`. |

Each value must be a positive whole number; anything else uses the default.

The registry of sandboxes is in memory and the records are in one SQLite file on the
container's scratch disk, so **run exactly one instance** (`--max-instances 1`). A restart
ends every sandbox; visitors get a fresh one on their next request. On platforms where
the scratch disk counts against memory, size the instance for it.

## Settings

| Variable | Meaning |
| --- | --- |
| `AMS_PREVIEW` | `public` for this mode. |
| `AMS_DEMO_LINK_URL` | Optional. An https address for the banner's link. |
| `AMS_DEMO_LINK_LABEL` | Optional. Up to 40 characters; "Get OpenAMS for your agency" by default. |
| `AMS_DEMO_HOURS`, `AMS_DEMO_MAX_SANDBOXES`, `AMS_DEMO_STARTS_PER_MINUTE` | See above. |

## Run the image locally

```sh
docker build -t openams-demo .
docker run --rm -p 8080:8080 -e AMS_PREVIEW=public openams-demo
```

Open http://localhost:8080. (Browsers accept the `Secure` cookie on `localhost`.)

## Deploy (Cloud Run)

```sh
PROJECT=<project-id>; REGION=us-central1; SERVICE=openams-demo
IMAGE=$REGION-docker.pkg.dev/$PROJECT/openams/demo:$(git rev-parse --short HEAD)

gcloud builds submit --project $PROJECT --tag $IMAGE .
gcloud run deploy $SERVICE --project $PROJECT --region $REGION --image $IMAGE \
  --allow-unauthenticated --min-instances 0 --max-instances 1 --memory 2Gi \
  --set-env-vars AMS_PREVIEW=public
```

Give the service its own service account with no roles: the demo reads and writes
nothing outside its container.

## Before you make one public

- Anyone can type anything into their own sandbox. Nobody else can see it, and it is
  deleted, but it does sit on your server until then. The banner asks for fictional
  data only.
- The limits above bound what one visitor or a script can make the server do. They are
  not a substitute for your platform's own request limits or a web application firewall
  if the demo draws abuse.
