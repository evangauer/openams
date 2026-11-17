import assert from "node:assert/strict";
import { demoLink } from "../src/lib/demo-link";

// The public demo's banner link is optional and must be a plain web address.
assert.equal(demoLink({}), null);
assert.equal(demoLink({ AMS_DEMO_LINK_URL: "" }), null);
assert.equal(demoLink({ AMS_DEMO_LINK_URL: "/start" }), null);
assert.equal(demoLink({ AMS_DEMO_LINK_URL: "javascript:alert(1)" }), null);
assert.equal(demoLink({ AMS_DEMO_LINK_URL: "http://ams.example/start" }), null, "plain http only on localhost");
assert.equal(demoLink({ AMS_DEMO_LINK_URL: "https://user:pass@ams.example/" }), null);
assert.deepEqual(demoLink({ AMS_DEMO_LINK_URL: "https://ams.example/start" }), {
  url: "https://ams.example/start",
  label: "Get OpenAMS for your agency",
});
assert.deepEqual(demoLink({ AMS_DEMO_LINK_URL: "http://localhost:4300/start", AMS_DEMO_LINK_LABEL: "  Start   now " }), {
  url: "http://localhost:4300/start",
  label: "Start now",
});
// A label that is too long falls back to the default; it is never cut mid-word.
assert.equal(
  demoLink({ AMS_DEMO_LINK_URL: "https://ams.example/", AMS_DEMO_LINK_LABEL: "x".repeat(41) })?.label,
  "Get OpenAMS for your agency",
);

console.log("Demo link checks passed.");
