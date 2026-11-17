import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { MailboxOAuth, mailboxRuntime } from "../dist/mailbox-oauth.js";

const now = new Date("2026-11-12T04:00:00Z");
const config = {
  origin: "http://127.0.0.1:4540",
  gmail: {
    clientId: "fictional-google-id",
    clientSecret: "fictional-google-secret",
  },
  microsoft365: {
    clientId: "fictional-microsoft-id",
    clientSecret: "fictional-microsoft-secret",
    tenant: "organizations",
  },
};
const tokens = (patch = {}) => ({
  access_token: "fictional-access",
  refresh_token: "fictional-refresh",
  expires_in: 3600,
  token_type: "Bearer",
  ...patch,
});
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function fixture(responses) {
  const calls = [];
  const oauth = new MailboxOAuth(
    config,
    async (url, init) => {
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      calls.push({ url, init });
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
    () => now,
  );
  return { oauth, calls };
}

for (const provider of ["gmail", "microsoft365"]) {
  test(`${provider}: authorization uses PKCE, random state, read-only scopes and a fixed provider callback`, async () => {
    const { oauth } = fixture([]);
    const one = await oauth.begin(provider),
      two = await oauth.begin(provider);
    assert.notEqual(one.state, two.state);
    assert.notEqual(one.verifier, two.verifier);
    assert.ok(one.state.length >= 32);
    const url = new URL(one.url);
    assert.equal(
      url.searchParams.get("code_challenge"),
      createHash("sha256").update(one.verifier).digest("base64url"),
    );
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("state"), one.state);
    assert.equal(
      url.searchParams.get("redirect_uri"),
      `${config.origin}/api/mailbox/callback/${provider}`,
    );
    assert.doesNotMatch(
      one.url,
      /fictional-google-secret|fictional-microsoft-secret/,
    );
    assert.doesNotMatch(url.searchParams.get("scope"), /send|modify|write/i);
    assert.equal(url.searchParams.get("response_type"), "code");
    if (provider === "gmail")
      assert.equal(url.searchParams.get("access_type"), "offline");
    else assert.match(url.searchParams.get("scope"), /offline_access/);
  });
  test(`${provider}: code exchange and refresh retain credentials only server-side and rotate refresh tokens`, async () => {
    const f = fixture([
      json(tokens()),
      json(
        tokens({
          access_token: "second-access",
          refresh_token: "rotated-refresh",
          expires_in: 1800,
        }),
      ),
      json(tokens({ refresh_token: undefined })),
    ]);
    const begin = await f.oauth.begin(provider);
    const result = await f.oauth.exchange(
      provider,
      new URLSearchParams({
        state: begin.state,
        code: "fictional-authorization-code",
      }),
      begin.state,
      begin.verifier,
    );
    assert.equal(result.expiresAt, "2026-11-12T05:00:00.000Z");
    assert.equal(f.calls[0].init.body.get("code_verifier"), begin.verifier);
    assert.equal(
      f.calls[0].init.body.get("code"),
      "fictional-authorization-code",
    );
    assert.equal(f.calls[0].init.body.get("grant_type"), "authorization_code");
    assert.equal(
      f.calls[0].init.body.get("client_secret"),
      config[provider].clientSecret,
    );
    const rotated = await f.oauth.refresh(provider, result);
    assert.equal(rotated.refreshToken, "rotated-refresh");
    assert.equal(rotated.expiresAt, "2026-11-12T04:30:00.000Z");
    assert.equal(
      f.calls[1].init.body.get("refresh_token"),
      "fictional-refresh",
    );
    assert.equal(
      (await f.oauth.refresh(provider, rotated)).refreshToken,
      "rotated-refresh",
      "A missing replacement keeps the previous refresh token",
    );
  });
  test(`${provider}: mismatched callbacks never redeem a code; malformed, under-scoped or denied grants fail closed`, async () => {
    const noRequest = fixture([]);
    const begin = await noRequest.oauth.begin(provider);
    await assert.rejects(
      noRequest.oauth.exchange(
        provider,
        new URLSearchParams({ code: "code", state: "wrong" }),
        begin.state,
        begin.verifier,
      ),
      (e) => e.code === "mailbox_authorization_failed",
    );
    assert.equal(noRequest.calls.length, 0);
    for (const response of [
      json(tokens({ refresh_token: undefined })),
      json(tokens({ scope: "User.Read" })),
      json(tokens({ expires_in: 0 })),
      json(
        {
          error: "invalid_grant",
          error_description: "sensitive-provider-detail",
        },
        400,
      ),
    ]) {
      const f = fixture([response]);
      await assert.rejects(
        f.oauth.exchange(
          provider,
          new URLSearchParams({ code: "code", state: begin.state }),
          begin.state,
          begin.verifier,
        ),
        (e) => {
          assert.equal(e.code, "mailbox_reconnect_required");
          assert.doesNotMatch(e.message, /sensitive-provider-detail/);
          return true;
        },
      );
    }
  });
}

test("Mailbox configuration remains optional and rejects partial credentials, unsafe callbacks and arbitrary authorities", () => {
  assert.equal(mailboxRuntime({}).oauth, undefined);
  const key = randomBytes(32).toString("base64");
  assert.equal(
    mailboxRuntime({ AMS_MAILBOX_ENCRYPTION_KEY: key }).oauth,
    undefined,
  );
  assert.throws(
    () => mailboxRuntime({ AMS_MAILBOX_GOOGLE_CLIENT_ID: "id" }),
    /both/,
  );
  assert.throws(
    () =>
      mailboxRuntime({
        AMS_MAILBOX_GOOGLE_CLIENT_ID: "id",
        AMS_MAILBOX_GOOGLE_CLIENT_SECRET: "fictional",
      }),
    /ENCRYPTION_KEY/,
  );
  for (const origin of [
    "http://agency.example.test",
    "https://agency.example.test/other",
    "https://user:password@agency.example.test",
    "https://agency.example.test?redirect=elsewhere",
  ])
    assert.throws(() => new MailboxOAuth({ ...config, origin }));
  assert.throws(
    () =>
      new MailboxOAuth({
        ...config,
        microsoft365: {
          ...config.microsoft365,
          tenant: "../../attacker.example.test",
        },
      }),
    /directory UUID/,
  );
  assert.equal(
    mailboxRuntime({
      AMS_MAILBOX_GOOGLE_CLIENT_ID: "id",
      AMS_MAILBOX_GOOGLE_CLIENT_SECRET: "fictional",
      AMS_MAILBOX_ENCRYPTION_KEY: key,
      AMS_APP_URL: config.origin,
    }).oauth.configured("gmail"),
    true,
  );
});
