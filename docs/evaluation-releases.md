# Evaluation releases

An evaluation pre-release is a tagged snapshot for developers to inspect, run
locally and test with fictional records. It is not a production-ready release.
Do not store real client or policy information in it.

## What to evaluate

Use Node.js 24.22.1 or a newer Node 24 release. From a clean checkout of the tag:

```sh
npm ci
npm run check
npm run dev
```

Open `http://127.0.0.1:4500` and choose **Explore demo agency**. You can also
evaluate a fictional CSV import, record changes, permissions, exports and local
backup/restore. See the [README](../README.md) and the [architecture](architecture.md).
The local application does not send messages, contact carriers, bind coverage or
move money when records are saved.

Cloud deployment and optional email-link/text sign-in are documented separately.
A passing local test suite does not establish hosted identity-provider support,
delivery of emails or text messages, operational recovery, or cross-agency security.
Complete the [deployment launch checklist](firebase.md#launch-checklist) and a
qualified security review before considering real client data.

## Release evidence

Each tagged pre-release must identify its source commit and record the actual
installation, tests and scans run, including failures or skipped checks and known
limitations. Before publication, maintainers review reachable Git history and assets
for secrets, private material and publication rights. Do not include private review
terms or sensitive findings in public release notes.

Release tags belong on `main`. Use GitHub's pre-release designation so evaluation
snapshots are distinguishable from a future stable release. An evaluation tag does
not open outside code contributions; see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Feedback

Report reproducible problems in issues using fictional examples. Follow
[SECURITY.md](../SECURITY.md) for private vulnerability reports. Never attach real
agency exports, client records, credentials or private environment files.
