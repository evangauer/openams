import assert from "node:assert/strict";
import {
  decodeJoinLink,
  encodeJoinLink,
  parseJoinLink,
  withoutJoinLink,
} from "../src/features/agency/join-link";

const id = "AbCdEfGhIjKlMnOpQrStUvWx";
const token = "a".repeat(43);

// The link lives in the fragment: "#i=<id>&t=<secret>".
assert.deepEqual(parseJoinLink(`#i=${id}&t=${token}`), { invitationId: id, token });
assert.deepEqual(parseJoinLink(`i=${id}&t=${token}`), { invitationId: id, token });

// Anything malformed is ignored, not repaired.
assert.equal(parseJoinLink(""), null);
assert.equal(parseJoinLink(`#i=${id}`), null, "no secret");
assert.equal(parseJoinLink(`#t=${token}`), null, "no invitation");
assert.equal(parseJoinLink(`#i=${id}&t=${token}x`), null, "secret too long");
assert.equal(parseJoinLink(`#i=${id}&t=${"a".repeat(42)}`), null, "secret too short");
assert.equal(parseJoinLink(`#i=${id}&t=${"a".repeat(42)}%2F`), null, "not base64url");
assert.equal(parseJoinLink(`#i=short&t=${token}`), null);
assert.equal(parseJoinLink(`#i=${id}%3Cscript%3E&t=${token}`), null);

// Kept for an hour at most, so sign-in can finish from the emailed link in another tab.
const now = Date.UTC(2026, 0, 15, 12);
const stored = encodeJoinLink({ invitationId: id, token }, now);
assert.deepEqual(decodeJoinLink(stored, now + 59 * 60 * 1000), { invitationId: id, token });
assert.equal(decodeJoinLink(stored, now + 61 * 60 * 1000), null);
assert.equal(decodeJoinLink(stored, now - 2 * 60 * 1000), null, "a time in the future isn't trusted");
assert.equal(decodeJoinLink(null, now), null);
assert.equal(decodeJoinLink("{not json", now), null);
assert.equal(decodeJoinLink(JSON.stringify({ invitationId: id, token }), now), null, "no savedAt");
// Stored values are checked again on the way out.
assert.equal(decodeJoinLink(JSON.stringify({ invitationId: id, token: "x", savedAt: now }), now), null);

// The address bar keeps the page, not the link.
assert.equal(
  withoutJoinLink(`https://app.example.test/join#i=${id}&t=${token}`),
  "https://app.example.test/join",
);

console.log("join link: ok");
