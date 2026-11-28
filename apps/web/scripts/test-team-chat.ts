// Team chat's failure rules: what each refusal means, how long to wait before trying
// again, and what an undelivered message honestly says.
import assert from "node:assert/strict";
import { AgencyRequestError } from "../src/features/agency/model";
import {
  CONVERSATION_MAX_MS,
  CONVERSATION_POLL_MS,
  PULSE_MAX_MS,
  PULSE_VISIBLE_MS,
  chatFailure,
  conversationInterval,
  retryDelay,
  undeliveredLabel,
} from "../src/features/agency/team-chat-model";

const refusal = (status: number, code = "request_failed", message = "Refused.") =>
  new AgencyRequestError(status, code, message);

// An ended session pauses chat; the workspace explains and resumes it.
assert.equal(chatFailure(refusal(401, "unauthorized")), "paused");
assert.equal(chatFailure(refusal(403, "membership_inactive")), "paused");
assert.equal(chatFailure(refusal(403, "agency_required")), "paused");
// Refused for good: retrying the same request can't help.
assert.equal(chatFailure(refusal(404, "not_found")), "rejected");
assert.equal(chatFailure(refusal(403, "chat_members_only")), "rejected");
assert.equal(chatFailure(refusal(400, "invalid_request")), "rejected");
assert.equal(chatFailure(refusal(409, "chat_id_reused")), "rejected");
// The service or the network: try again later.
for (const status of [408, 429, 500, 502, 503])
  assert.equal(chatFailure(refusal(status)), "offline", String(status));
assert.equal(chatFailure(new TypeError("Failed to fetch")), "offline");
assert.equal(chatFailure(new DOMException("aborted", "AbortError")), "offline");

// Backoff: the usual interval when healthy, doubling per failure, capped.
assert.equal(retryDelay(CONVERSATION_POLL_MS, 0, CONVERSATION_MAX_MS), 3_000);
assert.deepEqual(
  [1, 2, 3, 4, 5, 50].map((n) => retryDelay(CONVERSATION_POLL_MS, n, CONVERSATION_MAX_MS)),
  [6_000, 12_000, 24_000, 30_000, 30_000, 30_000],
);
assert.deepEqual(
  [0, 1, 2, 3, 4].map((n) => retryDelay(PULSE_VISIBLE_MS, n, PULSE_MAX_MS)),
  [15_000, 30_000, 60_000, 120_000, 120_000],
);
assert.equal(retryDelay(3_000, 10_000, 30_000), 30_000, "huge failure counts don't overflow");

// A quiet conversation is checked less often; an active one every 3 seconds.
assert.deepEqual(
  [0, 60_000, 119_999, 120_000, 599_999, 600_000, 3_600_000].map(conversationInterval),
  [3_000, 3_000, 3_000, 6_000, 6_000, 10_000, 10_000],
);

// Only a refusal says "not sent"; no answer means it may have been saved.
assert.equal(undeliveredLabel("offline"), "Delivery unconfirmed.");
assert.equal(undeliveredLabel("paused"), "Not sent: you're signed out.");
assert.equal(undeliveredLabel("rejected", "Teammate not found."), "Not sent: Teammate not found.");
assert.equal(undeliveredLabel("rejected", "Teammate not found"), "Not sent: Teammate not found.");
assert.equal(undeliveredLabel("rejected"), "Not sent: the message was refused.");

console.log("Team chat: failures classified, backoff capped, undelivered messages labelled honestly.");
