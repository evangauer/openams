# Contributing to OpenAMS

Thanks for your interest in OpenAMS.

## Right now

Outside code contributions are not open yet. The best ways to help today:

- **Open an issue** describing a workflow your current AMS makes painful.
- **Share how your agency works** (anonymized): book size, lines of business,
  direct-bill vs agency-bill, and which systems you'd need to connect.
- **Report security problems privately** using [SECURITY.md](SECURITY.md).

Evaluation pre-release tags do not open outside code contributions. We will announce
that opening here after the contributor license agreement is published. Before we
merge outside code, contributors will sign that agreement. It
lets the project offer commercial license terms to organizations that can't use
AGPLv3, while the code stays AGPLv3 for everyone else. We'll link it here when
it's ready.

## Ground rules

- **Fictional data only.** Never put real client, policy, carrier statement or
  agency data in issues, tests, fixtures, screenshots or documentation.
- **One trunk.** Branch from `main` and open a pull request into `main`.
  Releases are tags on `main`.
- **No secrets.** Never commit credentials or environment files other than
  `.env.example`. `node scripts/verify-oss-release.mjs` checks this.
- **Be honest in the product.** A screen must never claim that saving a record
  contacted a carrier, bound coverage, sent a message or moved money unless it
  actually did.

## Development

See **Try it locally** in the [README](README.md) and [docs/architecture.md](docs/architecture.md).
The runtime is Node.js 24 (see `.nvmrc`). The Firebase emulator test suites
(`npm run test:firebase-auth` and `npm run test:firebase` in `apps/api`) also need the
Firebase CLI (`firebase-tools`) and Java 21 on your PATH; everything else needs only
Node 24. Before opening a pull request, run:

```sh
npm run check
```

## License

The published code is licensed under GNU AGPLv3. The future contributor agreement
will be available for review before outside code contributions open; an unpublished
agreement does not apply retroactively to issues or feedback.
