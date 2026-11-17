// Agency limit refusals reach people as plain messages with their codes intact.
import assert from "node:assert/strict";
import { AgencyRequestError, request } from "../src/features/agency/model";

const originalFetch = globalThis.fetch;
let reply: () => Response = () => Response.json({});
globalThis.fetch = async () => reply();
const refusal = async () => {
  try {
    await request("commands", { method: "POST" });
  } catch (error) {
    assert.ok(error instanceof AgencyRequestError);
    return error;
  }
  throw new Error("expected a refusal");
};
try {
  for (const [status, error, message] of [
    [429, "agency_quota_exceeded", "Your agency has reached its daily limit of changes. Nothing was saved. The limit resets at midnight UTC."],
    [429, "rate_limited", "Your agency is sending too many requests. Wait a few seconds and try again."],
    [413, "storage_quota_exceeded", "Your agency has reached its document storage limit, so this file was not saved."],
  ] as const) {
    reply = () => Response.json({ error, message }, { status });
    const refused = await refusal();
    assert.equal(refused.status, status);
    assert.equal(refused.code, error);
    assert.equal(refused.message, message, "the API's own message is shown");
  }
  // A refusal without a JSON body still explains itself.
  reply = () => new Response("Too Many Requests", { status: 429 });
  assert.match((await refusal()).message, /too many requests/i);
  reply = () => new Response("", { status: 413 });
  assert.match((await refusal()).message, /Nothing was saved/);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("Agency limit refusals: codes and messages verified.");
