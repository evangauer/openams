import assert from "node:assert/strict";
import {
  parseImportCsv,
  importTemplates,
  readCsvRows,
  importKinds,
  importKindFromValue,
} from "../src/features/agency/import-csv";
import {
  parseStatementCsv,
  statementTemplate,
} from "../src/features/agency/statement-csv";

for (const kind of importKinds) assert.equal(importKindFromValue(kind), kind);
for (const value of ["../private", "javascript:alert(1)", "accounts\" onclick=\"alert(1)", ["accounts"], { length: 1 }, null]) {
  assert.equal(importKindFromValue(value), null);
}

const accounts = parseImportCsv(importTemplates.accounts, "accounts");
assert.equal(accounts[0].externalId, "example-001");
assert.equal(accounts[0].name, "Example Manufacturing");
assert.deepEqual(
  readCsvRows(
    '\uFEFFname,note\r\n"Acme, Inc.","Quoted ""value""\nand another line"\r\n',
  ),
  [
    ["name", "note"],
    ["Acme, Inc.", 'Quoted "value"\nand another line'],
  ],
);
assert.throws(
  () => readCsvRows('a,b\n"closed"unexpected,value'),
  /Invalid CSV quoting/,
);
assert.throws(
  () => parseImportCsv("external_id,name\na,b,extra", "accounts"),
  /expected 2/,
);
assert.throws(
  () => parseImportCsv("external_id,name,name\na,b,c", "accounts"),
  /template headers/,
);
const policies = parseImportCsv(importTemplates.policies, "policies");
assert.equal(policies[0].premiumCents, 1250000);
assert.equal(policies[0].commissionBps, 1500);
assert.throws(
  () =>
    parseImportCsv(
      importTemplates.policies.replace("12500", "12.123"),
      "policies",
    ),
  /at most two decimal/,
);
const statement = parseStatementCsv(statementTemplate);
for (const kind of ["contacts", "exposures", "notes", "tasks"] as const) {
  const rows = parseImportCsv(importTemplates[kind], kind);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].accountExternalId, "example-001");
  assert.equal(rows[0].sourceAuthor, "Previous team");
}
assert.deepEqual(
  parseImportCsv(importTemplates.exposures, "exposures")[0].values,
  { squareFeet: 5000 },
);
assert.equal(
  parseImportCsv(importTemplates.contacts, "contacts")[0].primary,
  true,
);
assert.throws(
  () =>
    parseImportCsv(
      importTemplates.contacts.replace(",true,", ",maybe,"),
      "contacts",
    ),
  /primary must/,
);
assert.throws(
  () =>
    parseImportCsv(
      "external_id,account_external_id,kind,name,values_json\nx,y,location,Z,[]",
      "exposures",
    ),
  /JSON object/,
);
assert.throws(
  () =>
    parseImportCsv(
      "external_id,account_external_id,body,occurred_at,owner_id\nx,y,Z,2026-01-01T00:00:00Z,bad",
      "notes",
    ),
  /template headers/,
);
assert.equal(statement[0].commissionCents, 187500);
assert.equal(statement[0].transaction, "new_business");
const negative = parseStatementCsv(
  statementTemplate.replace(
    "new_business,12500,1875",
    "cancellation,-100.01,-15.01",
  ),
);
assert.equal(negative[0].premiumCents, -10001);
assert.equal(negative[0].commissionCents, -1501);
assert.throws(
  () => parseStatementCsv(statementTemplate.repeat(51)),
  /between 1 and 50/,
);
console.log(
  "PASS AMS migration and direct-bill statement CSV parsing, quoted/newline fields, stable external IDs and signed monetary values.",
);
