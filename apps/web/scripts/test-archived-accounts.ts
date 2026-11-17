import assert from "node:assert/strict";
import {
  findAccount,
  readBook,
  type AgencySession,
  type AmsRecord,
} from "../src/features/agency/model";
import { AMS_DATA_SCHEMAS } from "@openams/contracts";

function account(id: string, archivedAt: string | null): AmsRecord<"accounts"> {
  return {
    id,
    kind: "accounts",
    data: AMS_DATA_SCHEMAS.accounts.parse({ name: `Fictional ${id}` }),
    archivedAt,
    createdAt: "2026-11-12T00:00:00Z",
    updatedAt: "2026-11-12T00:00:00Z",
    createdBy: "fictional-admin",
    updatedBy: "fictional-admin",
    revision: 1,
    version: "a".repeat(64),
  };
}

const archived = account("archived-account", "2026-11-12T01:00:00Z");
const active = account("active-account", null);
const originalFetch = globalThis.fetch;
const paths: string[] = [];
try {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://fictional.example.test");
    paths.push(url.pathname);
    if (url.pathname.endsWith("/accounts")) {
      assert.equal(url.searchParams.get("includeArchived"), "true");
      return Response.json(
        url.searchParams.get("cursor")
          ? { items: [active], nextCursor: null }
          : { items: [archived], nextCursor: "second-page" },
      );
    }
    return Response.json({ items: [], nextCursor: null });
  };
  const book = await readBook(
    { readableKinds: ["accounts", "policies"] } as AgencySession,
    new AbortController().signal,
  );
  assert.deepEqual(book.accounts?.map((record) => record.id), [active.id]);
  assert.deepEqual(book.archivedAccounts?.map((record) => record.id), [archived.id]);
  assert.equal(findAccount(book, archived.id)?.data.name, archived.data.name);
  assert.equal(findAccount(book, active.id)?.data.name, active.data.name);
  assert.equal(findAccount(book, "not-in-this-agency"), undefined);
  assert.equal(paths.filter((path) => path.endsWith("/accounts")).length, 2);

  // A later session without account access must not fetch or inherit references.
  paths.length = 0;
  const restricted = await readBook(
    { readableKinds: ["tasks"] } as AgencySession,
    new AbortController().signal,
  );
  assert.equal(findAccount(restricted, archived.id), undefined);
  assert.deepEqual(paths, ["/api/agency/records/tasks"]);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("PASS archived account references: paginated names remain available, active lists exclude archives, and session permissions are respected.");
