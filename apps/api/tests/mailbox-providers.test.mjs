import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMailboxClient,
  MAILBOX_MESSAGE_LIMIT,
} from "../dist/mailbox-providers.js";

const selected = { folderId: "CarrierUpdates", since: "2026-11-01T00:00:00Z" };
const receivedAt = "2026-11-12T03:00:00Z";
const original = Buffer.from(
  "From: Fictional Carrier <updates@example.test>\r\nTo: Agency <agency@example.test>\r\nSubject: Fictional renewal update\r\n\r\nPlease review the attached proposal.\r\n",
);
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
function fixture(provider, responses) {
  const calls = [];
  const client = createMailboxClient(provider, "fictional-test-token", {
    fetcher: async (raw, init) => {
      const url = new URL(raw);
      calls.push({ url, init });
      assert.equal(
        init.method,
        "GET",
        "Ingestion must never write to a mailbox",
      );
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, "Bearer fictional-test-token");
      assert.ok(init.signal instanceof AbortSignal);
      if (provider === "microsoft365")
        assert.match(init.headers.Prefer, /IdType="ImmutableId"/);
      const response = responses.shift();
      assert.ok(response, `Unexpected provider request ${url.pathname}`);
      return typeof response === "function" ? response(url, init) : response;
    },
  });
  return { client, calls, remaining: responses };
}
const rejected = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.doesNotMatch(
      error.message,
      /fictional-test-token|sensitive-provider-detail/,
    );
    return true;
  });
const googleMessage = (patch = {}) => ({
  id: "message1",
  labelIds: [selected.folderId],
  internalDate: String(Date.parse(receivedAt)),
  raw: original.toString("base64url"),
  ...patch,
});
const graphMeta = (patch = {}) => ({
  id: "opaque+Case/Id==",
  parentFolderId: selected.folderId,
  isDraft: false,
  receivedDateTime: receivedAt,
  ...patch,
});
const graphNext = (token = "page") =>
  `https://graph.microsoft.com/v1.0/me/mailfolders('${selected.folderId}')/messages/delta?$skiptoken=${token}`;
const graphDelta = `https://graph.microsoft.com/v1.0/me/mailFolders/${selected.folderId}/messages/delta?$deltatoken=checkpoint`;

test("Gmail initial pages retain the pre-listing anchor, then drain arrivals and label moves without duplicate IDs", async () => {
  const f = fixture("gmail", [
    json({ emailAddress: "agency@example.test", historyId: "100" }),
    json({ messages: [{ id: "first" }], nextPageToken: "opaque+/==" }),
    json({ messages: [{ id: "second" }] }),
    json({
      historyId: "180",
      history: [
        {
          messagesAdded: [{ message: { id: "new" } }],
          labelsAdded: [
            { message: { id: "new" }, labelIds: [selected.folderId] },
            { message: { id: "moved" }, labelIds: [selected.folderId] },
            { message: { id: "unrelated" }, labelIds: ["OtherLabel"] },
          ],
        },
      ],
      nextPageToken: "history-page",
    }),
    json({
      historyId: "200",
      history: [{ messagesAdded: [{ message: { id: "last" } }] }],
    }),
  ]);
  const one = await f.client.page(selected);
  assert.deepEqual(one.messageIds, ["first"]);
  assert.equal(one.cursor.anchor, "100");
  assert.equal(one.more, true);
  const two = await f.client.page(selected, one.cursor);
  assert.equal(f.calls[2].url.searchParams.get("pageToken"), "opaque+/==");
  assert.deepEqual(two.cursor, {
    provider: "gmail",
    phase: "history",
    anchor: "100",
  });
  assert.equal(two.more, true);
  const three = await f.client.page(selected, two.cursor);
  assert.deepEqual(three.messageIds, ["new", "moved"]);
  assert.equal(
    three.cursor.anchor,
    "100",
    "Do not advance history through an unfinished page set",
  );
  const four = await f.client.page(selected, three.cursor);
  assert.equal(f.calls[4].url.searchParams.get("startHistoryId"), "100");
  assert.deepEqual(four.cursor, {
    provider: "gmail",
    phase: "history",
    anchor: "200",
  });
  assert.equal(four.more, false);
  assert.equal(
    f.calls[1].url.searchParams.get("q"),
    `after:${Date.parse(selected.since) / 1000 - 1}`,
  );
  assert.equal(f.calls[1].url.searchParams.get("labelIds"), selected.folderId);
  assert.equal(f.remaining.length, 0);
});

test("Gmail empty folders still synchronize changes after the initial anchor", async () => {
  const f = fixture("gmail", [
    json({ emailAddress: "agency@example.test", historyId: "50" }),
    json({}),
    json({ historyId: "60" }),
  ]);
  const initial = await f.client.page(selected);
  assert.deepEqual(initial.messageIds, []);
  assert.equal(initial.more, true);
  assert.equal((await f.client.page(selected, initial.cursor)).more, false);
});

test("Gmail expired history requests an explicit resync; missing individual messages are skipped", async () => {
  const f = fixture("gmail", [json({}, 404), json({}, 404)]);
  await rejected(
    f.client.page(selected, {
      provider: "gmail",
      phase: "history",
      anchor: "1",
    }),
    "mailbox_sync_reset",
  );
  assert.equal(await f.client.original("message1", selected), null);
});

test("Gmail retains exact MIME bytes and source receipt time while excluding drafts, wrong labels, old mail and spam", async () => {
  const f = fixture("gmail", [
    json(googleMessage()),
    json(googleMessage({ labelIds: [selected.folderId, "SENT"] })),
    ...["DRAFT", "SPAM", "TRASH"].map((label) =>
      json(googleMessage({ labelIds: [selected.folderId, label] })),
    ),
    json(googleMessage({ labelIds: ["OtherLabel"] })),
    json(
      googleMessage({
        internalDate: String(Date.parse("2025-01-01T00:00:00Z")),
      }),
    ),
  ]);
  const inbound = await f.client.original("message1", selected);
  assert.deepEqual(inbound.bytes, original);
  assert.equal(inbound.receivedAt, new Date(receivedAt).toISOString());
  assert.equal(inbound.direction, "inbound");
  assert.equal(
    (await f.client.original("message1", selected)).direction,
    "outbound",
  );
  for (let index = 0; index < 5; index++)
    assert.equal(await f.client.original("message1", selected), null);
});

test("Outlook delta follows both documented link formats, retains immutable IDs and excludes removed/draft/old messages", async () => {
  const f = fixture("microsoft365", [
    json({
      value: [
        graphMeta(),
        { id: "removed", "@removed": { reason: "deleted" } },
        { id: "draft", isDraft: true },
        { id: "old", receivedDateTime: "2025-01-01T00:00:00Z" },
      ],
      "@odata.nextLink": graphNext(),
    }),
    json({ value: [{ id: "new" }], "@odata.deltaLink": graphDelta }),
    json({ value: [], "@odata.deltaLink": graphDelta }),
  ]);
  const one = await f.client.page(selected);
  assert.deepEqual(one.messageIds, ["opaque+Case/Id=="]);
  assert.equal(one.more, true);
  assert.equal(
    f.calls[0].url.searchParams.has("$filter"),
    false,
    "No filtered-delta 5,000-message cutoff",
  );
  const two = await f.client.page(selected, one.cursor);
  assert.equal(f.calls[1].url.toString(), graphNext());
  assert.equal(two.more, false);
  assert.equal((await f.client.page(selected, two.cursor)).more, false);
  assert.equal(f.calls[2].url.toString(), graphDelta);
});

test("Outlook paginated folder picker includes child folders and preserves case-sensitive opaque IDs", async () => {
  const parent = "Case+/==";
  const next = `https://graph.microsoft.com/v1.0/me/mailfolders('${encodeURIComponent(parent)}')/childFolders?$skiptoken=second`;
  const f = fixture("microsoft365", [
    json({
      value: [
        {
          id: parent,
          displayName: "Fictional carrier updates",
          childFolderCount: 2,
        },
      ],
    }),
    json({
      value: [{ id: "ChildOne", displayName: "Renewals", childFolderCount: 0 }],
      "@odata.nextLink": next,
    }),
    json({
      value: [{ id: "ChildTwo", displayName: "Claims", childFolderCount: 0 }],
    }),
  ]);
  const root = await f.client.folders();
  assert.equal(root.folders[0].hasChildren, true);
  const children = await f.client.folders({ parentId: root.folders[0].id });
  assert.equal(children.next, next);
  assert.equal(
    (await f.client.folders({ parentId: parent, next: children.next }))
      .folders[0].name,
    "Claims",
  );
  assert.equal(
    f.calls[1].url.pathname,
    "/v1.0/me/mailFolders/Case%2B%2F%3D%3D/childFolders",
  );
});

test("Outlook preserves MIME, excludes moved messages and does not claim a known direction", async () => {
  const f = fixture("microsoft365", [
    json(graphMeta()),
    new Response(original),
    json(graphMeta({ parentFolderId: "Personal" })),
    json(graphMeta({ isDraft: true })),
    json({}, 404),
  ]);
  const value = await f.client.original("opaque+Case/Id==", selected);
  assert.deepEqual(value.bytes, original);
  assert.equal(value.direction, "unknown");
  assert.equal(
    f.calls[0].url.pathname,
    "/v1.0/me/messages/opaque%2BCase%2FId%3D%3D",
  );
  assert.equal(await f.client.original("opaque+Case/Id==", selected), null);
  assert.equal(await f.client.original("opaque+Case/Id==", selected), null);
  assert.equal(await f.client.original("opaque+Case/Id==", selected), null);
});

test("Provider identities and selectable Gmail labels are normalized without exposing tokens", async () => {
  const g = fixture("gmail", [
    json({ emailAddress: "Agency@example.test", historyId: "10" }),
    json({
      labels: [
        { id: "INBOX", name: "Inbox" },
        { id: "DRAFT", name: "Drafts" },
        { id: "Label_1", name: "Carriers" },
      ],
    }),
  ]);
  assert.deepEqual(await g.client.identity(), {
    address: "Agency@example.test",
    remoteId: "agency@example.test",
  });
  assert.deepEqual(
    (await g.client.folders()).folders.map((f) => f.id),
    ["INBOX", "Label_1"],
  );
  const m = fixture("microsoft365", [
    json({
      id: "stable-user",
      mail: "agency@example.test",
      userPrincipalName: "login@example.test",
    }),
  ]);
  assert.deepEqual(await m.client.identity(), {
    address: "agency@example.test",
    remoteId: "stable-user",
  });
});

test("Opaque Graph pagination cannot send credentials to another host, user, folder or API resource", async () => {
  const forbidden = [
    "https://attacker.example.test/v1.0/me/mailFolders/CarrierUpdates/messages/delta",
    "http://graph.microsoft.com/v1.0/me/mailFolders/CarrierUpdates/messages/delta",
    "https://graph.microsoft.com:444/v1.0/me/mailFolders/CarrierUpdates/messages/delta",
    "https://secret@graph.microsoft.com/v1.0/me/mailFolders/CarrierUpdates/messages/delta",
    "https://graph.microsoft.com/v1.0/users/other/mailFolders/CarrierUpdates/messages/delta",
    "https://graph.microsoft.com/v1.0/me/mailFolders/carrierupdates/messages/delta",
    "https://graph.microsoft.com/v1.0/me/mailFolders/CarrierUpdates/messages/delta#fragment",
    "https://graph.microsoft.com/v1.0/me/drive/root",
    "https://graph.microsoft.com/v1.0/me/mailFolders/../messages/delta",
  ];
  for (const url of forbidden) {
    const f = fixture("microsoft365", []);
    await rejected(
      f.client.page(selected, {
        provider: "microsoft365",
        phase: "delta",
        url,
      }),
      "mailbox_response_invalid",
    );
    assert.equal(f.calls.length, 0);
  }
  const f = fixture("microsoft365", [
    json({ value: [{ id: "one" }], "@odata.nextLink": forbidden[0] }),
  ]);
  await rejected(f.client.page(selected), "mailbox_response_invalid");
  assert.equal(f.calls.length, 1);
});

test("Both providers classify reconnects, throttling and transient failures without leaking provider details", async () => {
  for (const provider of ["gmail", "microsoft365"]) {
    for (const [status, code] of [
      [401, "mailbox_reconnect_required"],
      [403, "mailbox_reconnect_required"],
      [500, "mailbox_unavailable"],
      [302, "mailbox_unavailable"],
    ]) {
      const f = fixture(provider, [
        json({ error: { message: "sensitive-provider-detail" } }, status),
      ]);
      await rejected(f.client.identity(), code);
    }
    const f = fixture(provider, [json({}, 429, { "retry-after": "120" })]);
    await assert.rejects(
      f.client.identity(),
      (e) => e.code === "mailbox_throttled" && e.retryAfterSeconds === 120,
    );
    const network = fixture(provider, [
      () => {
        throw new Error("sensitive-provider-detail fictional-test-token");
      },
    ]);
    await rejected(network.client.identity(), "mailbox_unavailable");
  }
  const quota = fixture("gmail", [
    json({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, 403),
  ]);
  await rejected(quota.client.identity(), "mailbox_throttled");
  const expired = fixture("microsoft365", [json({}, 410)]);
  await rejected(expired.client.page(selected), "mailbox_sync_reset");
});

test("Malformed responses never advance sync or silently turn corrupt MIME into evidence", async () => {
  const cases = [
    ["gmail", (c) => c.identity(), new Response("not json")],
    [
      "gmail",
      (c) => c.original("message1", selected),
      json(googleMessage({ raw: "a" })),
    ],
    [
      "gmail",
      (c) => c.original("message1", selected),
      json(googleMessage({ id: "different" })),
    ],
    ["microsoft365", (c) => c.page(selected), json({ value: [] })],
    [
      "microsoft365",
      (c) => c.page(selected),
      json({
        value: [],
        "@odata.deltaLink": graphDelta,
        "@odata.nextLink": graphNext(),
      }),
    ],
    [
      "microsoft365",
      (c) => c.original("opaque+Case/Id==", selected),
      json(graphMeta({ id: "different" })),
    ],
  ];
  for (const [provider, action, response] of cases)
    await rejected(
      action(fixture(provider, [response]).client),
      "mailbox_response_invalid",
    );
});

test("Mailbox response limits apply to declared and streamed bytes, even without Content-Length", async () => {
  for (const response of [
    new Response("small", {
      headers: { "content-length": String(MAILBOX_MESSAGE_LIMIT + 1) },
    }),
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAILBOX_MESSAGE_LIMIT));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
    ),
  ]) {
    const f = fixture("microsoft365", [json(graphMeta()), response]);
    await rejected(
      f.client.original("opaque+Case/Id==", selected),
      "mailbox_message_too_large",
    );
  }
});

test("Both providers stop a repeated pagination cursor instead of syncing forever", async () => {
  const gmail = fixture("gmail", [
    json({ messages: [{ id: "one" }], nextPageToken: "same" }),
    json({ historyId: "200", nextPageToken: "same" }),
  ]);
  await rejected(
    gmail.client.page(selected, {
      provider: "gmail",
      phase: "listing",
      anchor: "100",
      page: "same",
    }),
    "mailbox_response_invalid",
  );
  await rejected(
    gmail.client.page(selected, {
      provider: "gmail",
      phase: "history",
      anchor: "100",
      page: "same",
    }),
    "mailbox_response_invalid",
  );
  const microsoft = fixture("microsoft365", [
    json({ value: [], "@odata.nextLink": graphNext() }),
  ]);
  await rejected(
    microsoft.client.page(selected, {
      provider: "microsoft365",
      phase: "delta",
      url: graphNext(),
    }),
    "mailbox_response_invalid",
  );
});

test("Gmail includes the exact requested start instant, while Graph folder IDs cannot navigate to parent resources", async () => {
  const gmail = fixture("gmail", [
    json(googleMessage({ internalDate: String(Date.parse(selected.since)) })),
  ]);
  assert.deepEqual(
    (await gmail.client.original("message1", selected)).bytes,
    original,
  );
  const microsoft = fixture("microsoft365", []);
  await rejected(microsoft.client.folder(".."), "mailbox_response_invalid");
  assert.equal(microsoft.calls.length, 0);
});
