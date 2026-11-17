# OpenAMS Roadmap

OpenAMS is building a modern, open agency management system for U.S. independent
P&C agencies. This roadmap is a living document: it separates what exists from
what is planned. The fastest way to influence it is to
[open an issue](https://github.com/evangauer/openams/issues).

_Last reviewed: November 17, 2026._

## Available now

- Accounts (prospects and clients), contacts, addresses and producer/CSR ownership
- Policies with carriers, terms, coverages and premium
- Renewals with owner, stage, due dates and follow-ups
- Servicing tasks and requests with assignment and due dates
- Documents and correspondence filed to the account, with history
- CSV import with a dry run before anything is saved, and full export
- Certificates with agency-supplied authorized templates, holder management,
  reviewed PDFs, issuance snapshots, external-delivery records and linked reissue
  requests. OpenAMS distributes no licensed forms and does not send the certificate
  ([scope and limitations](docs/certificates.md))
- Direct-bill commission statements: expected vs received, matching and exceptions
  that need review
- Email filing to accounts: optional read-only Gmail and Microsoft 365 connections
  with a shared review and filing queue. Sync is manual, it needs provider setup, and
  it should be piloted before use with real correspondence
  ([setup and current limits](docs/mailboxes.md))
- Firebase self-hosting with email-link sign-in, Firestore and Cloud Storage
  ([deployment options](docs/self-hosting-options.md))
- [OpenAMS Cloud](https://openams.com), the hosted version run by the maintainers
- A [public demo](https://demo.openams.com) with fictional data
  ([how it works](docs/public-demo.md))

## Next

None of these exist yet.

- Self-hosting with Docker Compose and PostgreSQL
- Versioned REST API with scoped keys and signed webhooks
- Migration guides from common agency systems

## Later

These aren't supported yet.

- Agency-bill accounting (invoices, receipts, payables, reconciliation)
- Carrier downloads, which depend on authorized carrier and IVANS connections
- ACORD forms, which depend on form licensing
- Claims tracking
- Reporting: expirations, retention, production and commissions

## How we prioritize

1. Does it help a real agency do real work faster?
2. Does it keep the agency in control of its data?
3. Can the community build on it?
