import assert from "node:assert/strict";
import {
  AMS_DATA_SCHEMAS,
  type AmsRecord,
} from "@openams/contracts";
import {
  accountRelayReferences,
  loadAccountRelayConversation,
  loadAccountRelayWork,
} from "../src/features/agency/account-relay-model";
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
async function main() {
  const scope = ["primary", "retained"];
  const signal = new AbortController().signal;
  const work = {
    id: "lead",
    accountId: "retained",
    business: { name: "Fixture" },
    stage: "quoting",
    quotePackage: { status: "launched", carrierNames: ["Fixture Mutual"] },
  };
  assert.equal(
    (
      await loadAccountRelayWork("lead", scope, signal, async () =>
        response({ lead: work }),
      )
    ).state,
    "ready",
  );
  for (const status of [401, 403, 404]) {
    const result = await loadAccountRelayWork("lead", scope, signal, async () =>
      response({ lead: work }, status),
    );
    assert.equal(result.state, "restricted");
    assert.equal(result.work, null);
  }
  for (const lead of [
    { ...work, accountId: "other" },
    { ...work, accountId: null },
    { ...work, id: "different" },
  ]) {
    const result = await loadAccountRelayWork("lead", scope, signal, async () =>
      response({ lead }),
    );
    assert.equal(result.state, "moved");
    assert.equal(result.work, null);
  }
  let calls = 0;
  await assert.rejects(
    loadAccountRelayConversation("lead", scope, signal, async () => {
      calls++;
      return response({ lead: { ...work, accountId: "moved" } });
    }),
    /no longer available/,
  );
  assert.equal(
    calls,
    1,
    "Do not fetch a thread after its work moved to another account",
  );
  const message = {
    id: "message",
    direction: "inbound",
    subject: "Fictional renewal",
    from: "insured@example.test",
    to: "agent@example.test",
    bodyPreview: "Preview",
    body: "<script>literal text only</script>",
    messageAt: "2026-11-06T12:00:00Z",
    sendStatus: "received",
    attachmentCount: 1,
  };
  const paths: string[] = [];
  const conversation = await loadAccountRelayConversation(
    "lead",
    scope,
    signal,
    async (url, options) => {
      paths.push(String(url));
      assert.equal(options?.cache, "no-store");
      assert.equal(options?.signal, signal);
      return response(
        String(url).includes("communications")
          ? {
              thread: {
                messages: [
                  message,
                  message,
                  {
                    ...message,
                    id: "older",
                    messageAt: "2026-11-05T12:00:00Z",
                  },
                ],
                awaitingReply: true,
              },
            }
          : { lead: work },
      );
    },
  );
  assert.equal(paths.length, 2);
  assert.deepEqual(
    conversation.messages.map((row) => row.id),
    ["message", "older"],
  );
  assert.equal(conversation.awaitingReply, true);
  assert.equal(conversation.messages[0].body, message.body);
  await assert.rejects(
    loadAccountRelayConversation("lead", scope, signal, async (url) =>
      String(url).includes("communications")
        ? response({}, 403)
        : response({ lead: work }),
    ),
    /current Relay access/,
  );
  await assert.rejects(
    loadAccountRelayConversation("lead", scope, signal, async (url) =>
      response(
        String(url).includes("communications")
          ? { thread: null }
          : { lead: work },
      ),
    ),
    /history is unavailable/,
  );
  const record = (id: string, data: object) =>
    ({
      id,
      kind: "accounts",
      data: AMS_DATA_SCHEMAS.accounts.parse(data),
      archivedAt: null,
    }) as AmsRecord<"accounts">;
  const primary = record("primary", {
    name: "Primary",
    leadIds: ["lead", "same"],
    consolidatedAccountIds: ["retained"],
  });
  const retained = record("retained", {
    name: "Prior",
    leadIds: ["same", "other-lead"],
    consolidation: {
      targetId: "primary",
      at: "2026-11-06T00:00:00Z",
      by: "admin",
      targetEpoch: 1,
      targetVersion: "a".repeat(64),
      sourceProfileDigest: "b".repeat(64),
    },
  });
  const unrelated = record("elsewhere", {
    name: "Other",
    leadIds: ["unrelated"],
  });
  assert.deepEqual(
    accountRelayReferences(
      { accounts: [primary, retained, unrelated] },
      "retained",
    ),
    {
      accountIds: ["primary", "retained"],
      leadIds: ["lead", "other-lead", "same"],
    },
  );
  console.log(
    "AMS linked Relay work: permission failures, moved identities, thread recheck, deduplication and consolidated identity scope passed.",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
