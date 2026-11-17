import assert from "node:assert/strict";
import {
  AMS_DATA_SCHEMAS,
  type AmsKind,
  type AmsRecord,
} from "@openams/contracts";
import {
  accountDuplicateCandidates,
  accountIdentities,
  canonicalAccountId,
  sameAccount,
} from "../src/features/agency/account-identity-model";
import {
  accountBook,
  groupAccountBook,
  matchingAccountIds,
  accountSummary,
} from "../src/features/agency/account-model";
import type { Book } from "../src/features/agency/model";
function record<K extends AmsKind>(
  kind: K,
  id: string,
  data: object,
): AmsRecord<K> {
  return {
    id,
    kind,
    data: AMS_DATA_SCHEMAS[kind].parse(data),
    version: "a".repeat(64),
    revision: 1,
    createdAt: "2026-11-06T00:00:00Z",
    updatedAt: "2026-11-06T00:00:00Z",
    createdBy: "admin",
    updatedBy: "admin",
    archivedAt: null,
  } as AmsRecord<K>;
}
const root = record("accounts", "root", {
  name: "Fixture LLC",
  email: "office@example.test",
  phone: "+1 (608) 555-0100",
  consolidatedAccountIds: ["source"],
});
const source = record("accounts", "source", {
  name: "Prior name",
  consolidation: {
    targetId: "root",
    at: "2026-11-06T00:00:00Z",
    by: "admin",
    targetEpoch: 1,
    targetVersion: "b".repeat(64),
    sourceProfileDigest: "c".repeat(64),
  },
  customFields: [
    { id: "field", label: "Branch code", type: "text", value: "MIDWEST-42" },
  ],
});
const duplicate = record("accounts", "other", {
  name: "Fixture, LLC",
  phone: "6085550100",
});
const unrelated = record("accounts", "unrelated", {
  name: "Different company",
});
const policy = record("policies", "policy", {
  accountId: source.id,
  number: "POL-ORIGINAL",
  carrier: "Fixture",
  line: "GL",
  effectiveDate: "2026-01-01",
  expirationDate: "2027-01-01",
  status: "active",
  premiumCents: 50000,
});
const book: Book = {
  accounts: [root, source, duplicate, unrelated],
  policies: [policy],
  commissions: [
    record("commissions", "commission", {
      accountId: source.id,
      policyId: policy.id,
      carrier: "Fixture",
      transaction: "new_business",
      transactionDate: "2026-01-01",
      premiumCents: 50000,
      expectedCents: 5000,
      notes: "PRIVATE-MATCH-TERM",
    }),
  ],
};
assert.equal(canonicalAccountId(book, source.id), root.id);
assert.ok(sameAccount(book, source.id, root.id));
assert.ok(!sameAccount(book, source.id, unrelated.id));
assert.deepEqual(
  accountIdentities(book, root.id).map((row) => row.id),
  [root.id, source.id],
);
assert.deepEqual(
  accountBook(book, root.id, ["accounts", "policies"]).policies,
  [policy],
);
assert.equal(
  accountSummary(accountBook(book, root.id, ["policies"]), "2026-11-06")
    .premiumCents,
  50000,
);
assert.deepEqual(groupAccountBook(book, ["policies"]).get(root.id)?.policies, [
  policy,
]);
assert.deepEqual(
  [...matchingAccountIds(book, "MIDWEST-42", ["accounts", "policies"])],
  [root.id],
);
assert.deepEqual(
  [...matchingAccountIds(book, "POL-ORIGINAL", ["accounts", "policies"])],
  [root.id],
);
assert.equal(
  matchingAccountIds(book, "PRIVATE-MATCH-TERM", ["accounts", "policies"]).size,
  0,
);
const candidates = accountDuplicateCandidates(root, book);
assert.equal(candidates.length, 1);
assert.equal(candidates[0].account.id, duplicate.id);
assert.deepEqual(candidates[0].reasons, ["Matching name", "Same phone"]);
console.log(
  "PASS account identity projection: retained identities, consolidated search and totals, role scope and duplicate review hints.",
);
