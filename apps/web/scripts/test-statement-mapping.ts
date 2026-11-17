import assert from "node:assert/strict";
import {
  inspectStatementCsv,
  parseStatementCsv,
  statementMoney,
  type StatementMapping,
} from "../src/features/agency/statement-csv";
const csv =
  'Policy Number,Effective Date,Paid Date,Paid Commission,Insured\n000123,1/2/2026,11/4/2026,"$1,234.56",Fixture LLC\n';
const info = inspectStatementCsv(csv);
assert.equal(info.mapping.commission, "Paid Commission");
assert.equal(info.mapping.transaction_date, "");
const rows = parseStatementCsv(csv, {
  mapping: info.mapping,
  dateFormat: "us",
});
assert.equal(rows[0].policyNumber, "000123");
assert.equal(rows[0].effectiveDate, "2026-01-02");
assert.equal(rows[0].paidDate, "2026-11-04");
assert.equal(rows[0].transactionDate, null);
assert.equal(rows[0].transaction, null);
assert.equal(rows[0].premiumCents, null);
assert.equal(rows[0].commissionCents, 123456);
assert.throws(
  () => parseStatementCsv(csv, { mapping: info.mapping, dateFormat: "iso" }),
  /date format/,
);
assert.equal(
  parseStatementCsv(csv, { mapping: info.mapping, dateFormat: "day_first" })[0]
    .effectiveDate,
  "2026-02-01",
);
assert.throws(
  () =>
    parseStatementCsv(csv.replace("1/2/2026", "2/30/2026"), {
      mapping: info.mapping,
      dateFormat: "us",
    }),
  /valid calendar date/,
);
assert.throws(
  () =>
    parseStatementCsv(csv, {
      mapping: { ...info.mapping, commission: "" },
      dateFormat: "us",
    }),
  /Map paid commission/,
);
assert.throws(
  () =>
    parseStatementCsv(csv, {
      mapping: { ...info.mapping, premium: "Paid Commission" },
      dateFormat: "us",
    }),
  /only once/,
);
assert.throws(() => inspectStatementCsv("Policy,policy\na,b"), /distinct/);
assert.equal(
  inspectStatementCsv(
    "policy_number,effective_date,commission,paid_commission\na,b,c,d",
  ).mapping.commission,
  "",
);
for (const [value, expected] of [
  ["($1,000.01)", -100001],
  ["-$0.01", -1],
  ["0.10", 10],
  ["1234.5", 123450],
  ["1,234,567.89", 123456789],
] as const)
  assert.equal(statementMoney(value), expected);
for (const value of [
  "1,23.00",
  "10.005",
  "1e3",
  "--12",
  "(-12)",
  "NaN",
  "",
  "1000000001.00",
])
  assert.throws(() => statementMoney(value));
const full =
  "Policy,Effective Date,Transaction Date,Transaction Type,Premium,Commission\nP1,2026-01-01,2026-01-01,NB,1000,150";
const mapped = parseStatementCsv(full, {
  mapping: inspectStatementCsv(full).mapping,
  dateFormat: "iso",
});
assert.equal(mapped[0].transaction, "new_business");
assert.equal(mapped[0].premiumCents, 100000);
assert.throws(
  () =>
    parseStatementCsv(full.replace(",NB,", ",constructor,"), {
      mapping: inspectStatementCsv(full).mapping,
      dateFormat: "iso",
    }),
  /Unknown transaction/,
);
assert.throws(
  () =>
    parseStatementCsv(full, {
      mapping: {
        ...inspectStatementCsv(full).mapping,
        paid_date: "Missing",
      } as StatementMapping,
      dateFormat: "iso",
    }),
  /headers from this file/,
);
console.log(
  "PASS statement mapping: actual carrier headers, optional source fields, explicit date formats, exact signed cents and malformed input rejection.",
);
