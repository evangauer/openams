import assert from "node:assert/strict";
import { test } from "node:test";
import { emailPreview } from "../dist/email-preview.js";

test("HTML fallback extracts readable text without executing markup or exposing image URLs", () => {
  const preview = emailPreview({ html: '<h1>Fictional renewal</h1><p>Premium &amp; fees: $1,350</p><script>alert(1)</script><style>body{display:none}</style><img src="https://tracking.example.test/pixel">' });
  assert.match(preview.body, /Fictional renewal/i);
  assert.match(preview.body, /Premium & fees: \$1,350/);
  assert.doesNotMatch(preview.body, /script|alert\(1\)|display:none|tracking.example.test|<p>/);
  assert.equal(preview.bodyTruncated, false);
});

test("plain-text alternatives stay intact and truncation does not split a Unicode pair", () => {
  assert.deepEqual(emailPreview({ text: "Original plain-text alternative", html: "<p>Other representation</p>" }), { body: "Original plain-text alternative", bodyTruncated: false });
  const long = "a".repeat(19999) + "😀";
  const preview = emailPreview({ text: long });
  assert.equal(preview.body, "a".repeat(19999));
  assert.equal(preview.bodyTruncated, true);
});

test("oversized and deeply nested HTML stays bounded and clearly marks an incomplete preview", () => {
  const oversized = emailPreview({ html: "<p>Fictional update</p>" + " ".repeat(2_000_000) });
  assert.match(oversized.body, /Fictional update/);
  assert.equal(oversized.bodyTruncated, true);
  const nested = emailPreview({ html: "<div>".repeat(150) + "Deep content" + "</div>".repeat(150) });
  assert.equal(nested.bodyTruncated, true);
  assert.ok(nested.body.length <= 20000);
  assert.deepEqual(emailPreview({ text: "   ", html: false }), { body: "", bodyTruncated: false });
});
