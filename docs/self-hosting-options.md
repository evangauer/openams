# Self-hosting options

OpenAMS is pre-release. The Firebase deployment path is implemented; other cloud
backends below are not interchangeable configuration options. Use fictional data
while evaluating, and complete the [launch checklist](firebase.md#launch-checklist)
before considering real agency data.

| Option | Status | Where to start |
| --- | --- | --- |
| Firebase / Google Cloud | Implemented deployment path: App Hosting, email-link authentication, Firestore and Cloud Storage | [Firebase runbook](self-hosting.md) |
| Firebase / Google Cloud on Cloud Run | Implemented alternative: a container image you configure at runtime, so you can run several isolated OpenAMS deployments from one Google Cloud project (named Firestore databases, Identity Platform tenants) | [Cloud Run](cloud-run.md) |
| Local Node.js + SQLite | Implemented for evaluation on your computer, with local files and test-role selection | [Local setup](../README.md#try-it-locally) |
| Docker / Cloud Run preview | Implemented fictional-data preview behind Google IAP; records reset when the container restarts | [Hosted preview](hosted-preview.md) |
| Supabase | Not implemented; no Supabase adapter or deployment runbook | Implementation requirements below |
| VPS / dedicated server with Docker Compose + PostgreSQL | Planned; no Compose stack or PostgreSQL adapter | Implementation requirements below |

## Deploy the supported cloud option

Follow the [Firebase self-hosting runbook](self-hosting.md) in your own Google Cloud
project. It covers billing, database and file storage, authentication, App Hosting,
secrets, custom domains, App Check, API-key restrictions, reminders, recovery,
monitoring and email-domain setup. Read the [architecture](firebase.md) and
[identity model](hosted-identity.md) for the implementation details.

To run the same release as a Cloud Run service instead of App Hosting, or to run
several isolated OpenAMS deployments from one Google Cloud project, see
[Cloud Run](cloud-run.md). Separate projects remain the stronger boundary.

To use an AI coding agent, give it this prompt:

```text
Read AGENTS.md and docs/self-hosting-options.md, then follow docs/self-hosting.md
for a Firebase deployment in a project I own. Work phase by phase and show the
verification results. Ask at each HUMAN step. Keep deployment-specific values and
credentials out of Git. Do not describe skipped checks as passes or a successful
build as production readiness.
```

The runbook includes an external deployment verifier. Run the cloud checks with
`--project`, `--api-key` and `--expect-app-check` as documented; a basic invocation
alone does not check every protection. Also test actual sign-in and recovery.
A successful existing deployment does not prove that the runbook has been tested
from scratch in a new project.

## Evaluate locally or in a preview

The [README](../README.md#try-it-locally) covers Node.js setup and local backups.
Local records and files persist in `~/.openams/local` by default. The local test-role
picker is not hosted authentication; do not expose the local evaluation server as
an internet-facing agency service.

The [Docker preview](hosted-preview.md) has a different purpose: protected reviewer
access to fictional data. Its scratch storage is disposable. Adding a persistent
volume does not turn that preview into a supported production deployment.

## What Supabase support would require

Supabase is not currently a documented way to run OpenAMS. Pointing environment
variables at a Supabase project will not replace the Firebase implementation.
Before publishing executable deployment instructions, implement and verify:

- A PostgreSQL repository adapter and migrations, preserving transaction boundaries,
  revisions, audit history, idempotency and tenant isolation.
- An authentication and membership adapter, including email-link sign-in, invitations,
  session revocation and server-side permissions.
- A file-storage adapter with access controls, integrity checks and write-once behavior.
- Abuse controls and scheduled reminders appropriate to the chosen hosting platform.
- Database and file backups, a tested restore procedure, upgrade instructions and
  end-to-end deployment checks.

Use the [existing adapter boundaries](architecture.md) and SQLite/Firestore
conformance tests as the starting point. Document the actual hosting and access
model before choosing direct browser access or server-only data access.

## What traditional server hosting would require

A VPS or dedicated-server path needs the PostgreSQL adapter and migrations above,
plus a supported authentication provider and durable document storage. A complete
runbook must include a Compose stack or service definitions, HTTPS ingress, secret
provisioning, database migrations, reminders scheduling, monitoring, backup/restore,
and upgrade/rollback procedures.

There is currently no turnkey Compose/PostgreSQL deployment in this repository.
See the [roadmap](../ROADMAP.md); the repository-root Dockerfile is for the IAP preview
(`deploy/firebase.Dockerfile` is the Firebase-mode image, which still needs Firebase).
Until this path is implemented and tested, use the Firebase runbook or local
fictional-data evaluation instead of treating these requirements as install steps.
