import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyIapAssertion } from "../src/lib/server/iap";

const audience = "/projects/123456789/locations/us-central1/services/openams-preview";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const keys = async () => [{ ...publicKey.export({ format: "jwk" }), kid: "test-key" }];
const now = Date.UTC(2026, 10, 8, 22, 0, 0);
const seconds = Math.floor(now / 1000);
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = { alg: "ES256", kid: "test-key" },
) {
  const body = `${b64(header)}.${b64({
    iss: "https://cloud.google.com/iap",
    aud: audience,
    iat: seconds - 10,
    exp: seconds + 600,
    email: "reviewer@example.test",
    sub: "accounts.google.com:123",
    ...claims,
  })}`;
  const signature = sign("sha256", Buffer.from(body), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${body}.${signature}`;
}

const check = (value: string | null) => verifyIapAssertion(value, { audience, keys, now });

const ok = await check(token());
assert.deepEqual(ok, {
  ok: true,
  email: "reviewer@example.test",
  subject: "accounts.google.com:123",
});

const rejects: Array<[string, string | null, string]> = [
  ["missing header", null, "missing assertion"],
  ["malformed", "not-a-jwt", "malformed assertion"],
  ["wrong algorithm", token({}, { alg: "HS256", kid: "test-key" }), "unexpected algorithm"],
  ["unknown key", token({}, { alg: "ES256", kid: "other" }), "unknown signing key"],
  ["wrong issuer", token({ iss: "https://example.test" }), "wrong issuer"],
  ["wrong audience", token({ aud: "/projects/1/global/backendServices/2" }), "wrong audience"],
  ["expired", token({ exp: seconds - 120 }), "expired"],
  ["future", token({ iat: seconds + 600 }), "issued in the future"],
  ["no identity", token({ email: undefined }), "missing identity"],
];
for (const [name, value, reason] of rejects) {
  const result = await check(value);
  assert.equal(result.ok, false, name);
  assert.ok(!result.ok && result.reason.startsWith(reason), `${name}: ${JSON.stringify(result)}`);
}

// A signature from a different key, or a payload edited after signing, never passes.
const [head, payload, signature] = token().split(".");
const edited = `${head}.${b64({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), email: "attacker@example.test" })}.${signature}`;
assert.deepEqual(await check(edited), { ok: false, reason: "bad signature" });

console.log(
  `PASS IAP assertion: valid identity accepted; ${rejects.length + 1} forged, expired or misaddressed assertions refused.`,
);
