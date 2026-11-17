import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AmsListSchema } from "@openams/contracts";
import { AmsService } from "../dist/service.js";
import { Mailboxes } from "../dist/mailboxes.js";
import {
  SqliteMailboxStore,
  FirestoreMailboxStore,
} from "../dist/mailbox-store.js";
import { MailboxVault } from "../dist/mailbox-credentials.js";
import { MailboxProviderError } from "../dist/mailbox-providers.js";
import {
  backend,
  openRepository,
  openFiles,
  firebaseServices,
} from "./support/backend.mjs";

const owner = {
  tenantId: "agency",
  userId: "owner",
  role: "admin",
  name: "Fictional Owner",
};
const member = {
  ...owner,
  userId: "member",
  role: "member",
  name: "Fictional Member",
};
const manager = {
  ...owner,
  userId: "manager",
  role: "manager",
  name: "Fictional Manager",
};
const viewer = {
  ...owner,
  userId: "viewer",
  role: "viewer",
  name: "Fictional Viewer",
};
const since = "2026-11-01T00:00:00Z";
const original = (id) =>
  Buffer.from(
    [
      "From: Fictional Carrier <updates@example.test>",
      "To: Agency <agency@example.test>",
      `Subject: Fictional renewal ${id}`,
      `Message-ID: <${id}@example.test>`,
      "Date: Thu, 12 Nov 2026 04:00:00 +0000",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="fictional"',
      "",
      "--fictional",
      "Content-Type: text/html; charset=utf-8",
      "",
      `<p>Fictional update ${id}: proposed premium $1,350. Review before making changes.</p><script>window.bad = true</script>`,
      "--fictional",
      "Content-Type: text/plain",
      'Content-Disposition: attachment; filename="proposal.txt"',
      "",
      "Fictional proposal only. No coverage bound.",
      "--fictional--",
      "",
    ].join("\r\n"),
  );
const rejected = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });

async function fixture(t, provider = "gmail") {
  const directory = await mkdtemp(join(tmpdir(), "ams-mailbox-workflow-"));
  const repository = openRepository(join(directory, "agency.sqlite"));
  const store =
    backend === "firebase"
      ? new FirestoreMailboxStore(
          (await firebaseServices()).firestore,
          `mbworkflow_${randomUUID().replaceAll("-", "")}`,
        )
      : new SqliteMailboxStore(repository);
  const files = openFiles(join(directory, "files"));
  let now = new Date("2026-11-12T04:00:00Z");
  const members = async (tenant) =>
    tenant === "agency"
      ? [owner, member, manager, viewer].map((a) => ({
          id: a.userId,
          name: a.name,
          role: a.role,
          active: true,
          email: `${a.userId}@example.test`,
        }))
      : [];
  const service = new AmsService({ repository, members, now: () => now });
  const vault = new MailboxVault(randomBytes(32).toString("base64"));
  const calls = { originals: [], pages: [], exchanges: 0, refreshes: 0 };
  const cursor =
    provider === "gmail"
      ? { provider, phase: "history", anchor: "200" }
      : {
          provider,
          phase: "delta",
          url: "https://graph.microsoft.com/v1.0/me/mailFolders/Carriers/messages/delta?$deltatoken=next",
        };
  const client = {
    identity: async () => ({
      address: "agency@example.test",
      remoteId: "fictional-stable-mailbox",
    }),
    folders: async () => ({
      folders: [
        {
          id: "Carriers",
          name: "Fictional carrier updates",
          hasChildren: false,
        },
      ],
      next: null,
    }),
    folder: async (id) => ({
      id,
      name: "Fictional carrier updates",
      hasChildren: false,
    }),
    page: async (_selection, position) => {
      calls.pages.push(position);
      return {
        messageIds: ["mail1", "mail2", "mail3", "mail4"],
        cursor,
        more: false,
      };
    },
    original: async (id) => {
      calls.originals.push(id);
      return {
        bytes: original(id),
        receivedAt: now.toISOString(),
        direction: provider === "gmail" ? "inbound" : "unknown",
      };
    },
  };
  const credentials = () => ({
    accessToken: "fictional-access-token",
    refreshToken: "fictional-refresh-token",
    expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
  });
  const oauth = {
    configured: () => true,
    begin: async () => {
      const state = randomBytes(32).toString("base64url");
      return {
        state,
        verifier: "fictional-verifier",
        url: `https://consent.example.test/?state=${state}`,
      };
    },
    exchange: async () => {
      calls.exchanges++;
      return credentials();
    },
    refresh: async () => {
      calls.refreshes++;
      return credentials();
    },
  };
  const deps = {
    store,
    repository,
    files,
    members,
    service: () => service,
    vault,
    oauth,
    client: () => client,
    now: () => now,
  };
  const mailboxes = new Mailboxes(deps);
  const account = (
    await service.execute(owner, {
      id: randomUUID(),
      kind: "accounts",
      action: "create",
      data: { name: "Fictional Workshop" },
      reason: "",
    })
  ).records[0];
  const connect = async (who = owner) => {
    const start = await mailboxes.begin(who, provider);
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    return mailboxes.complete(
      who,
      provider,
      new URLSearchParams({ state, code: "fictional-code" }).toString(),
    );
  };
  const connection = await connect();
  const select = () =>
    mailboxes.selectFolder(owner, connection.id, {
      folderId: "Carriers",
      since,
      shareWithAgency: true,
    });
  const list = async (status = "review") =>
    (await mailboxes.messages(member, { status })).items;
  const filing = (message, patch = {}) => ({
    expectedRevision: message.revision,
    accountId: account.id,
    expectedVersion: account.version,
    policyId: null,
    direction: message.direction,
    shareWithAgency: true,
    ...patch,
  });
  t.after(async () => {
    repository.close?.();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    mailboxes,
    store,
    repository,
    files,
    service,
    deps,
    calls,
    client,
    cursor,
    account,
    connection,
    connect,
    select,
    list,
    filing,
    now: () => now,
    advance: (ms) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

for (const provider of ["gmail", "microsoft365"]) {
  test(`${backend}/${provider}: consent, bounded sync, restart, review, original and filing form one durable workflow`, async (t) => {
    const f = await fixture(t, provider);
    assert.equal(f.connection.state, "choose_folder");
    await rejected(
      f.mailboxes.sync(member, f.connection.id),
      "mailbox_folder_required",
    );
    assert.equal(f.calls.pages.length, 0);
    await assert.rejects(
      f.mailboxes.selectFolder(owner, f.connection.id, {
        folderId: "Carriers",
        since,
        shareWithAgency: false,
      }),
    );
    await f.select();
    const first = await f.mailboxes.sync(member, f.connection.id);
    assert.equal(first.imported, 3);
    assert.equal(first.connection.hasMore, true);
    assert.equal(first.connection.lastSyncedAt, null);
    const persisted = await f.store.get(
      owner.tenantId,
      "connections",
      f.connection.id,
    );
    assert.equal(
      persisted.cursor,
      null,
      "The final page cursor must wait for the fourth message",
    );
    assert.deepEqual(persisted.pending.ids, ["mail4"]);
    const restarted = new Mailboxes(f.deps);
    const second = await restarted.sync(member, f.connection.id);
    assert.equal(second.imported, 1);
    assert.equal(second.connection.hasMore, false);
    assert.equal(second.connection.lastSyncedAt, f.now().toISOString());
    assert.equal(
      f.calls.pages.length,
      1,
      "Restart continues the saved page rather than losing its tail",
    );
    const messages = await f.list();
    assert.equal(messages.length, 4);
    const mail = messages.find((m) => m.subject === "Fictional renewal mail1");
    assert.match(mail.body, /proposed premium \$1,350/);
    assert.doesNotMatch(mail.body, /window.bad|<script>/i);
    assert.equal(mail.attachmentCount, 1);
    assert.deepEqual(
      await restarted.original(member, mail.id),
      original("mail1"),
    );
    const accountBefore = await f.repository.get(
      owner.tenantId,
      "accounts",
      f.account.id,
    );
    const result = await restarted.file(member, mail.id, f.filing(mail));
    assert.equal(result.status, "filed");
    assert.equal(
      (await restarted.file(member, mail.id, f.filing(mail))).correspondenceId,
      result.correspondenceId,
      "A browser retry safely returns the completed filing",
    );
    const filed = await f.repository.get(
      owner.tenantId,
      "correspondence",
      result.correspondenceId,
    );
    assert.equal(filed.data.source, provider);
    assert.equal(filed.data.sourceConnectionId, f.connection.id);
    assert.equal(filed.data.sourceMessageId, "mail1");
    assert.equal(filed.data.documentIds.length, 2);
    assert.equal(filed.data.filedBy, member.userId);
    assert.equal(
      (await f.repository.get(owner.tenantId, "accounts", f.account.id))
        .version,
      accountBefore.version,
    );
    assert.equal(
      (
        await f.repository.list(
          owner.tenantId,
          "policies",
          AmsListSchema.parse({}),
        )
      ).items.length,
      0,
      "Import/filing never creates or binds a policy",
    );
    assert.equal(
      (
        await f.repository.list(
          owner.tenantId,
          "correspondence",
          AmsListSchema.parse({}),
        )
      ).items.length,
      1,
    );
    assert.equal((await f.mailboxes.sync(member, f.connection.id)).imported, 0);
    await f.mailboxes.sync(member, f.connection.id);
    assert.equal(
      f.calls.originals.length,
      4,
      "Incremental replay does not download the same original twice",
    );
    const output = JSON.stringify([
      await f.mailboxes.list(member),
      await f.mailboxes.messages(member, { status: "filed" }),
    ]);
    assert.doesNotMatch(
      output,
      /fictional-access-token|fictional-refresh-token|storageKey|credentials|deltaToken|deltatoken|authorization/,
    );
  });
}

test(`${backend}: mailbox authorization is bound to agency, provider, member, expiry and single use`, async (t) => {
  const f = await fixture(t);
  const start = await f.mailboxes.begin(owner, "gmail");
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  const query = new URLSearchParams({
    state,
    code: "fictional-code",
  }).toString();
  await rejected(
    f.mailboxes.complete(manager, "gmail", query),
    "mailbox_authorization_invalid",
  );
  await rejected(
    f.mailboxes.complete(owner, "microsoft365", query),
    "mailbox_authorization_invalid",
  );
  await rejected(
    f.mailboxes.complete({ ...owner, tenantId: "other" }, "gmail", query),
    "permission_denied",
  );
  const before = f.calls.exchanges;
  const both = await Promise.allSettled([
    f.mailboxes.complete(owner, "gmail", query),
    f.mailboxes.complete(owner, "gmail", query),
  ]);
  assert.equal(both.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.calls.exchanges, before + 1);
  await rejected(
    f.mailboxes.complete(owner, "gmail", query),
    "mailbox_authorization_invalid",
  );
  const expired = await f.mailboxes.begin(owner, "gmail");
  f.advance(11 * 60_000);
  await rejected(
    f.mailboxes.complete(
      owner,
      "gmail",
      new URLSearchParams({
        state: new URL(expired.authorizationUrl).searchParams.get("state"),
        code: "code",
      }).toString(),
    ),
    "mailbox_authorization_invalid",
  );
});

test(`${backend}: interrupted sync retries pending IDs and an expired cursor preserves reviewed evidence`, async (t) => {
  const f = await fixture(t);
  await f.select();
  const download = f.client.original;
  let fail = true;
  f.client.original = async (id) => {
    if (id === "mail2" && fail)
      throw new MailboxProviderError("mailbox_unavailable", "Try again.");
    return download(id);
  };
  await rejected(
    f.mailboxes.sync(member, f.connection.id),
    "mailbox_unavailable",
  );
  assert.equal((await f.list()).length, 1);
  assert.deepEqual(
    (await f.store.get(owner.tenantId, "connections", f.connection.id)).pending
      .ids,
    ["mail2", "mail3", "mail4"],
  );
  fail = false;
  await f.mailboxes.sync(member, f.connection.id);
  assert.equal((await f.list()).length, 4);
  f.client.page = async () => {
    throw new MailboxProviderError("mailbox_sync_reset", "History expired.");
  };
  await rejected(
    f.mailboxes.sync(member, f.connection.id),
    "mailbox_sync_reset",
  );
  const failed = (await f.mailboxes.list(member)).items[0];
  await f.mailboxes.reset(owner, f.connection.id, failed.revision);
  assert.equal((await f.list()).length, 4);
  assert.equal(
    (await f.store.get(owner.tenantId, "connections", f.connection.id)).cursor,
    null,
  );
  assert.ok(
    (await f.mailboxes.events(owner, f.connection.id)).items.some(
      (entry) => entry.action === "sync_reset",
    ),
  );
});

test(`${backend}: throttling persists a retry delay and refresh occurs once under the mailbox lease`, async (t) => {
  const f = await fixture(t);
  await f.select();
  const page = f.client.page;
  f.client.page = async () => {
    throw new MailboxProviderError(
      "mailbox_throttled",
      "Wait for the provider.",
      120,
    );
  };
  await rejected(
    f.mailboxes.sync(member, f.connection.id),
    "mailbox_throttled",
  );
  assert.equal(
    (await f.mailboxes.list(member)).items[0].nextAttemptAt,
    "2026-11-12T04:02:00.000Z",
  );
  f.client.page = page;
  await rejected(
    f.mailboxes.sync(member, f.connection.id),
    "mailbox_throttled",
  );
  f.advance(3600_000);
  await f.mailboxes.sync(member, f.connection.id);
  assert.equal(f.calls.refreshes, 1);
  await f.mailboxes.sync(member, f.connection.id);
  assert.equal(f.calls.refreshes, 1);
});

test(`${backend}: disconnect cancels the write authority of an in-flight sync and reauthorization keeps prior evidence`, async (t) => {
  const f = await fixture(t);
  await f.select();
  let started, resume;
  const atDownload = new Promise((resolve) => {
    started = resolve;
  });
  const barrier = new Promise((resolve) => {
    resume = resolve;
  });
  const download = f.client.original;
  f.client.original = async (id) => {
    started();
    await barrier;
    return download(id);
  };
  const syncing = f.mailboxes.sync(member, f.connection.id);
  await atDownload;
  await rejected(f.mailboxes.sync(member, f.connection.id), "mailbox_busy");
  const connection = (await f.mailboxes.list(member)).items[0];
  await f.mailboxes.disconnect(owner, connection.id, connection.revision);
  resume();
  await rejected(syncing, "mailbox_changed");
  assert.equal((await f.list()).length, 0);
  const disconnected = await f.store.get(
    owner.tenantId,
    "connections",
    connection.id,
  );
  assert.equal(disconnected.credentials, null);
  assert.equal(disconnected.state, "disconnected");
  await rejected(
    f.mailboxes.sync(member, f.connection.id),
    "mailbox_disconnected",
  );
  const reconnected = await f.connect();
  assert.equal(reconnected.id, connection.id);
  assert.equal(reconnected.state, "connected");
  f.client.original = download;
  await f.mailboxes.sync(member, f.connection.id);
  assert.equal((await f.list()).length, 3);
});

test(`${backend}: import failures are visible and retryable, dismissal is reversible and role checks apply to every operation`, async (t) => {
  const f = await fixture(t);
  await f.select();
  const download = f.client.original;
  f.client.original = async (id) => {
    if (id === "mail1")
      throw new MailboxProviderError(
        "mailbox_message_too_large",
        "Review this large message in the mailbox.",
      );
    return download(id);
  };
  await f.mailboxes.sync(member, f.connection.id);
  const error = (await f.list("error"))[0];
  assert.equal(error.originalAvailable, false);
  await rejected(f.mailboxes.original(member, error.id), "not_found");
  f.client.original = download;
  const retried = await f.mailboxes.retry(member, error.id, error.revision);
  assert.equal(retried.status, "review");
  const dismissed = await f.mailboxes.dismiss(
    member,
    retried.id,
    retried.revision,
    "Fictional duplicate notice.",
  );
  assert.equal(dismissed.status, "dismissed");
  const returned = await f.mailboxes.retry(
    member,
    dismissed.id,
    dismissed.revision,
  );
  assert.equal(returned.status, "review");
  await rejected(f.mailboxes.begin(member, "gmail"), "permission_denied");
  await rejected(
    f.mailboxes.folders(member, f.connection.id, {}),
    "permission_denied",
  );
  await rejected(f.mailboxes.list(viewer), "permission_denied");
  await rejected(f.mailboxes.messages(viewer, {}), "permission_denied");
  await rejected(
    f.mailboxes.original(viewer, returned.id),
    "permission_denied",
  );
  await rejected(
    f.mailboxes.file(viewer, returned.id, f.filing(returned)),
    "permission_denied",
  );
  await rejected(
    f.mailboxes.sync({ ...member, userId: "removed" }, f.connection.id),
    "permission_denied",
  );
});

test(`${backend}: filing recovers a lost service response and rejects changing the destination during an uncertain filing`, async (t) => {
  const f = await fixture(t);
  await f.select();
  await f.mailboxes.sync(member, f.connection.id);
  const message = (await f.list())[0];
  const execute = f.service.fileCorrespondence.bind(f.service);
  f.service.fileCorrespondence = async (...args) => {
    await execute(...args);
    throw new Error("Simulated lost API response after commit");
  };
  const filed = await f.mailboxes.file(member, message.id, f.filing(message));
  assert.equal(filed.status, "filed");
  assert.equal(
    (
      await f.repository.list(
        owner.tenantId,
        "correspondence",
        AmsListSchema.parse({}),
      )
    ).items.length,
    1,
  );
  const uncertain = (await f.list())[0];
  f.service.fileCorrespondence = async () => {
    throw new Error("Simulated interrupted request before a known result");
  };
  await rejected(
    f.mailboxes.file(member, uncertain.id, f.filing(uncertain)),
    "mailbox_filing_interrupted",
  );
  const pending = (await f.list("filing"))[0];
  await rejected(
    f.mailboxes.file(manager, pending.id, f.filing(pending)),
    "mailbox_filing_in_progress",
  );
  await rejected(
    f.mailboxes.file(
      member,
      pending.id,
      f.filing(pending, { accountId: "other" }),
    ),
    "mailbox_filing_in_progress",
  );
  f.service.fileCorrespondence = execute;
  assert.equal(
    (await f.mailboxes.file(member, uncertain.id, f.filing(uncertain))).status,
    "filed",
  );
});

test(`${backend}: failed account validation returns the queue to review and stale reviewers cannot overwrite a decision`, async (t) => {
  const f = await fixture(t);
  await f.select();
  await f.mailboxes.sync(member, f.connection.id);
  const message = (await f.list())[0];
  await rejected(
    f.mailboxes.file(
      member,
      message.id,
      f.filing(message, { accountId: "missing" }),
    ),
    "account_unavailable",
  );
  const returned = (await f.list()).find((m) => m.id === message.id);
  assert.equal(returned.status, "review");
  assert.equal(returned.accountId, null);
  await rejected(
    f.mailboxes.dismiss(
      member,
      message.id,
      message.revision,
      "Stale dismissal.",
    ),
    "mailbox_changed",
  );
  await assert.rejects(
    f.mailboxes.file(
      member,
      returned.id,
      f.filing(returned, { shareWithAgency: false }),
    ),
  );
  assert.equal(
    (await f.mailboxes.file(member, returned.id, f.filing(returned))).status,
    "filed",
  );
});

test(`${backend}: racing identical originals to different accounts files once and keeps the losing review recoverable`, async (t) => {
  const f = await fixture(t);
  const other = (
    await f.service.execute(owner, {
      id: randomUUID(),
      kind: "accounts",
      action: "create",
      data: { name: "Fictional Other Workshop" },
      reason: "",
    })
  ).records[0];
  f.client.original = async () => ({
    bytes: original("identical-original"),
    receivedAt: f.now().toISOString(),
    direction: "inbound",
  });
  await f.select();
  await f.mailboxes.sync(member, f.connection.id);
  const [one, two] = await f.list();
  let count = 0,
    release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const execute = f.service.fileCorrespondence.bind(f.service);
  f.service.fileCorrespondence = async (...args) => {
    if (++count === 2) release();
    await barrier;
    return execute(...args);
  };
  const results = await Promise.allSettled([
    f.mailboxes.file(member, one.id, f.filing(one)),
    f.mailboxes.file(
      member,
      two.id,
      f.filing(two, { accountId: other.id, expectedVersion: other.version }),
    ),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.find((r) => r.status === "rejected").reason.code,
    "email_already_filed",
  );
  assert.equal(
    (
      await f.repository.list(
        owner.tenantId,
        "correspondence",
        AmsListSchema.parse({}),
      )
    ).items.length,
    1,
  );
  assert.equal((await f.list("filing")).length, 0);
  const losingId = results[0].status === "rejected" ? one.id : two.id;
  const losing = await f.mailboxes.getMessage(member, losingId);
  assert.equal(losing.status, "review");
  assert.equal(losing.accountId, null);
  assert.equal(losing.error.code, "email_already_filed");
});

test(`${backend}: changing the selected folder requires renewed sharing and retains previous imported evidence`, async (t) => {
  const f = await fixture(t);
  await f.select();
  await f.mailboxes.sync(member, f.connection.id);
  await rejected(
    f.mailboxes.selectFolder(owner, f.connection.id, {
      folderId: "NewFolder",
      since,
      shareWithAgency: true,
    }),
    "mailbox_folder_fixed",
  );
  await assert.rejects(
    f.mailboxes.selectFolder(owner, f.connection.id, {
      folderId: "NewFolder",
      since,
      shareWithAgency: false,
      replaceSelection: true,
    }),
  );
  const changed = await f.mailboxes.selectFolder(owner, f.connection.id, {
    folderId: "NewFolder",
    since,
    shareWithAgency: true,
    replaceSelection: true,
  });
  assert.equal(changed.folder.id, "NewFolder");
  assert.equal(changed.lastSyncedAt, null);
  assert.equal(changed.hasMore, true);
  const saved = await f.store.get(
    owner.tenantId,
    "connections",
    f.connection.id,
  );
  assert.equal(saved.cursor, null);
  assert.equal(saved.pending, null);
  assert.equal((await f.list()).length, 3);
});
