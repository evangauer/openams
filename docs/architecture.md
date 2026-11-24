# Architecture

OpenAMS is a TypeScript monorepo with three packages. One deployment serves one
agency, using local SQLite or the hosted Firestore and object-storage adapters.
Both paths share the same record commands and permission checks.

```
browser ──► apps/web (Next.js) ──► /api/agency/* proxy ──► apps/api (Express) ──► repository
                                                                        │
                                                         packages/contracts (shared schemas)
```

## packages/contracts

Zod schemas for every agency record kind (accounts, contacts, policies, renewals,
tasks, service requests, certificates, claims, documents, invoices, statements, hosted
forms and their submissions, and more), plus the role permissions (`admin`, `manager`, `member`, `accountant`,
`viewer`). The API and the web app both import these, so a record that validates in
the browser validates the same way on the server.

## apps/api

- **`service.ts`**: the domain. Every change is a command that authenticates the actor,
  checks permission and record versions, validates references and writes an audit
  entry in the same transaction. Retried commands are idempotent.
- **`repository.ts`**: the storage interface. **`sqlite-repository.ts`** implements it
  with Node's built-in SQLite. A PostgreSQL implementation is planned for Cloud.
  **`firebase/firestore-repository.ts`** implements it on
  Cloud Firestore (everything under `tenants/{tenantId}/…`; writes are buffered and
  committed in one Firestore transaction), and **`firebase/storage-files.ts`** stores
  write-once document bytes in Cloud Storage. `npm run test:firebase --workspace
  @openams/api` runs a SQLite/Firestore conformance suite and the whole API suite
  against the local Firebase emulators (Java 21 and the `firebase` CLI required).
- **`routes.ts`**: the HTTP API, built by `createAmsRouter(dependencies)`. Sign-in,
  storage, team membership and the agency calendar are injected, so self-hosted,
  Cloud and local evaluation differ only in the dependencies they pass.
- **`import.ts`**, **`correspondence.ts`**, **`task-follow-up.ts`**: CSV migration with a
  dry run, filing original emails with attachments, and durable reminders.
- **`mailboxes.ts`**, **`mailbox-providers.ts`**, **`mailbox-store.ts`**: optional
  read-only Gmail and Microsoft 365 ingestion, durable sync checkpoints and a
  staff-reviewed queue. Encrypted grants and unfiled originals are separate from
  ordinary agency records. See [Incoming mail](mailboxes.md) for setup and limits.
- **`chat.ts`**, **`firebase/firestore-chat.ts`**: team and direct conversations
  using local SQLite or hosted Firestore. Shared routes check active agency
  membership and direct-message participants. Immutable messages, retry receipts,
  read markers and presence are separate from client records. Operational backups
  must retain these chat collections; normal client-record exports exclude them.
- **`form-routes.ts`**, **`form-links.ts`**, **`firebase/firestore-form-links.ts`**:
  [hosted forms](forms.md). An agency publishes a form at a public link; a client's
  answers and files arrive without a session and wait as a submission until staff file
  them to an account. The link index is the only thing that maps a link to an agency.
  The question catalog and the answer rules live in `packages/contracts`, so the page
  and the server check answers the same way.
- **`firebase/identity.ts`**: opt-in hosted identity (`AMS_AUTH_MODE=firebase`):
  Firebase email-link sign-in, session cookies, agency creation, invitations and team
  membership. See [hosted-identity.md](hosted-identity.md).
- **`local-server.ts`** and **`local-demo.ts`**: the loopback-only evaluation server and
  the fictional sample agency. The server refuses to start outside development, the
  [hosted preview](hosted-preview.md) and the [public demo](public-demo.md), where
  **`demo-sandboxes.ts`** gives each visitor a private, expiring copy.

## apps/web

A Next.js app. The workspace UI lives in `src/features/agency`. The browser talks only
to `/api/agency/*`, which checks the request origin and session, then forwards an
allowlisted path to the API. The one page for people outside the agency is a hosted form
at `/f/<link>` (`src/features/forms`); it and `/api/forms/*` never read a session. Local evaluation uses per-role test sessions stored in an
HTTP-only cookie scoped to that path. Hosted mode stores a Firebase session cookie in
`__Host-openams_session` and proxies identity calls through `/api/identity/*`.

One deployment serves one agency. In hosted mode the administrator named at install
sets the agency up on first sign-in and invites the team from the Team page; see
[hosted identity](hosted-identity.md).

## Relay extension points

OpenAMS works without Relay. When an agency connects a Relay workspace, these hooks
light up:

- `relayWorkspaceEnabled` (router dependency): shows the Relay panel on accounts,
  with linked quote work and an "Open Relay account" action.
- `originalEmail` (router dependency): files an original email from the connected
  Relay mailbox to an account. Without it, staff upload `.eml` files directly.
- `relay_mailbox` (correspondence source): records that an email was captured in Relay.

Planned: Relay AI quoting started from an account, with results returned to it, and
the Relay assistant working on account records through the OpenAMS API.

## Not built yet

- Outbound invitation email (invitations are recorded; the inviter tells the person)
- PostgreSQL storage with row-level security
- Licensed certificate forms. The [certificate workflow](certificates.md) renders agency-supplied authorized PDFs; OpenAMS does not ship ACORD assets.
- Outbound email, carrier downloads, payments
