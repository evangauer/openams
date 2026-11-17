# OpenAMS: agent working agreement

This repository will be public. Treat everything you commit as published.

- **Fictional data only.** Never copy real client, policy, carrier, prospect or
  agency names or records into code, fixtures, docs, screenshots or commit
  messages. This includes names from private Get Talky or Relay material.
- **No private Relay internals.** OpenAMS connects to Relay through public,
  documented APIs. Do not copy Relay-internal code, hostnames, credentials or
  operational notes into this repository without an explicit decision to open them.
- **No control features.** OpenAMS is the AMS an agency uses. By default a deployment
  serves one agency; the optional open sign-up mode (`AMS_SIGNUP=open`) lets one
  deployment host many isolated agencies. Do not add anything that manages or observes
  agencies from outside: no admin or operator APIs, plans, trials, billing, usage
  tracking or cross-agency views. Open sign-up must stay opt-in and keep every agency
  isolated by the server-derived tenant. An outside system (billing, compliance) may
  affect an agency only through the generic external access control
  (docs/external-access.md); never add provider-specific code for it here. Tools that run many deployments live outside this
  repository and use only generic, documented, optional settings (runtime environment
  variables, the read-only status endpoint). Describe such settings generically, and
  never name a particular hosting service, console or company in code or docs.
- **No secrets.** Keep credentials and environment files out of Git. Run
  `node scripts/verify-oss-release.mjs` before pushing.
- **One trunk.** Branch from `main`, open a pull request into `main`, and never
  force-push `main`. Releases are tags.
- **Honest product behavior.** No screen may claim a carrier was contacted,
  coverage was bound, a message was sent or money moved unless it actually was.
- **Evidence over claims.** Record the exact commands you ran and their results in
  the pull request. A green build is not production readiness.
- Runtime: Node.js 24 (`.nvmrc`).
