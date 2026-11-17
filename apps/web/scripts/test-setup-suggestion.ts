import assert from "node:assert/strict";
import {
  decodeSetupSuggestion,
  encodeSetupSuggestion,
  parseSetupSuggestion,
  withoutSetupSuggestion,
} from "../src/features/agency/setup-suggestion";

// A link may suggest an agency name and an email; both are optional.
assert.deepEqual(parseSetupSuggestion("?agency=Harbor%20Agency&email=Sam%40Harbor.example"), {
  agencyName: "Harbor Agency",
  email: "sam@harbor.example",
});
assert.deepEqual(parseSetupSuggestion("?agency=%20Harbor%20%20Agency%20"), { agencyName: "Harbor Agency" });
assert.deepEqual(parseSetupSuggestion("?email=sam@harbor.example"), { email: "sam@harbor.example" });
assert.equal(parseSetupSuggestion(""), null);
assert.equal(parseSetupSuggestion("?scheme=dusk"), null);

// Malformed or oversized values are ignored, not trimmed into something else.
assert.equal(parseSetupSuggestion(`?agency=${"a".repeat(121)}`), null);
assert.equal(parseSetupSuggestion("?email=not-an-email"), null);
assert.equal(parseSetupSuggestion("?email=%3Cscript%3E@x.example"), null);
assert.deepEqual(parseSetupSuggestion("?agency=Harbor%0AAgency%E2%80%AE"), { agencyName: "Harbor Agency" });
assert.deepEqual(parseSetupSuggestion("?agency=Harbor&email=bad"), { agencyName: "Harbor" });

// Kept for a day, so sign-in can finish from the emailed link in another tab.
const now = Date.UTC(2026, 0, 15, 12);
const stored = encodeSetupSuggestion({ agencyName: "Harbor Agency", email: "sam@harbor.example" }, now);
assert.deepEqual(decodeSetupSuggestion(stored, now + 60 * 60 * 1000), {
  agencyName: "Harbor Agency",
  email: "sam@harbor.example",
});
assert.equal(decodeSetupSuggestion(stored, now + 25 * 60 * 60 * 1000), null);
assert.equal(decodeSetupSuggestion(stored, now - 2 * 60 * 1000), null, "a time in the future isn't trusted");
assert.equal(decodeSetupSuggestion(null, now), null);
assert.equal(decodeSetupSuggestion("{not json", now), null);
assert.equal(decodeSetupSuggestion(JSON.stringify({ agencyName: "Harbor" }), now), null, "no savedAt");
// Stored values are checked again on the way out.
assert.equal(
  decodeSetupSuggestion(JSON.stringify({ agencyName: "a".repeat(500), savedAt: now }), now),
  null,
);

// The suggestion leaves the address bar; everything else stays.
assert.equal(
  withoutSetupSuggestion("https://ams.example/?agency=Harbor&scheme=dusk&email=sam%40harbor.example#top"),
  "https://ams.example/?scheme=dusk#top",
);
assert.equal(withoutSetupSuggestion("https://ams.example/?agency=Harbor"), "https://ams.example/");

console.log("Setup suggestion checks passed.");
