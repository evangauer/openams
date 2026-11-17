import test from "node:test";
import assert from "node:assert/strict";
import { createSchedulerAuthorization } from "../dist/firebase/scheduler.js";

const serviceAccount = "reminders@example-project.iam.gserviceaccount.com";
const audience = "https://ams.example.test/api/internal/reminders";
const valid = {
  iss: "https://accounts.google.com",
  email: serviceAccount,
  email_verified: true,
};

function run(handler, authorization) {
  return new Promise((resolve) => {
    const response = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body, next: false });
      },
    };
    handler(
      { header: (name) => (name === "authorization" ? authorization : undefined) },
      response,
      () => resolve({ status: 200, next: true }),
    );
  });
}

const client = (payload, seen = {}) => ({
  verifyIdToken: async ({ idToken, audience: expected }) => {
    seen.idToken = idToken;
    seen.audience = expected;
    if (payload instanceof Error) throw payload;
    return { getPayload: () => payload };
  },
});

test("scheduler accepts only the configured service account and audience", async () => {
  const seen = {};
  const allowed = createSchedulerAuthorization({ serviceAccount, audience, client: client(valid, seen) });
  assert.equal((await run(allowed, "Bearer token-1")).next, true);
  assert.deepEqual(seen, { idToken: "token-1", audience });

  for (const payload of [
    { ...valid, email: "someone-else@example-project.iam.gserviceaccount.com" },
    { ...valid, email_verified: false },
    { ...valid, iss: "https://evil.example.test" },
    null,
    new Error("bad signature or audience"),
  ]) {
    const handler = createSchedulerAuthorization({ serviceAccount, audience, client: client(payload) });
    const result = await run(handler, "Bearer token-2");
    assert.equal(result.next, false);
    assert.equal(result.status, 404);
  }
});

test("scheduler refuses missing tokens and unconfigured deployments", async () => {
  const handler = createSchedulerAuthorization({ serviceAccount, audience, client: client(valid) });
  for (const header of [undefined, "", "Basic abc", "Bearer", "Bearer a b"])
    assert.equal((await run(handler, header)).status, 404);
  for (const options of [{ serviceAccount: undefined, audience }, { serviceAccount, audience: undefined }]) {
    const unconfigured = createSchedulerAuthorization({ ...options, client: client(valid) });
    assert.equal((await run(unconfigured, "Bearer token")).status, 404);
  }
});
