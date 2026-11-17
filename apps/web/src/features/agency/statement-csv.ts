import { AmsDate } from "@openams/contracts";
import { readCsvRows } from "./import-csv";
export const statementTemplate =
  "policy_number,effective_date,transaction_date,transaction,premium,commission\nEXAMPLE-GL-001,2026-01-01,2026-01-01,new_business,12500,1875\n";
export const statementColumns = [
  "policy_number",
  "effective_date",
  "transaction_date",
  "paid_date",
  "transaction",
  "premium",
  "commission",
] as const;
export type StatementColumn = (typeof statementColumns)[number];
export type StatementMapping = Record<StatementColumn, string>;
export type StatementDateFormat = "iso" | "us" | "day_first";
export const columnLabels: Record<StatementColumn, string> = {
  policy_number: "Policy number",
  effective_date: "Policy effective date",
  transaction_date: "Transaction effective date",
  paid_date: "Paid date",
  transaction: "Transaction type",
  premium: "Transaction premium",
  commission: "Paid commission",
};
const aliases: Record<StatementColumn, string[]> = {
  policy_number: ["policynumber", "policyno", "policy", "policyid"],
  effective_date: ["effectivedate", "policyeffectivedate", "termeffectivedate"],
  transaction_date: [
    "transactiondate",
    "transactioneffectivedate",
    "endorsementdate",
  ],
  paid_date: ["paiddate", "paymentdate", "datepaid"],
  transaction: [
    "transaction",
    "transactiontype",
    "transtype",
    "transactioncode",
  ],
  premium: ["premium", "transactionpremium", "paidpremium", "writtenpremium"],
  commission: [
    "commission",
    "paidcommission",
    "commissionpaid",
    "commissionamount",
    "agencycommission",
  ],
};
export function inspectStatementCsv(text: string) {
  const rows = readCsvRows(text);
  const headers = rows[0]?.map((value) => value.trim());
  if (
    !headers?.length ||
    headers.length > 50 ||
    headers.some((value) => !value || value.length > 200) ||
    new Set(headers.map((value) => value.toLowerCase())).size !== headers.length
  )
    throw new Error(
      "Use distinct, nonempty column headers (up to 50 columns).",
    );
  if (rows.length < 2 || rows.length > 51)
    throw new Error(
      "Review between 1 and 50 statement rows per batch. Use a distinct statement reference for each batch.",
    );
  const mapping = Object.fromEntries(
    statementColumns.map((key) => {
      const matches = headers.filter((header) =>
        aliases[key].includes(header.toLowerCase().replace(/[^a-z0-9]/g, "")),
      );
      return [key, matches.length === 1 ? matches[0] : ""];
    }),
  ) as StatementMapping;
  return { headers, mapping, count: rows.length - 1 };
}
/** Parse decimal text exactly; never silently round sub-cent source amounts. */
export function statementMoney(value: string): number {
  let amount = value.trim();
  const parentheses = /^\(.*\)$/.test(amount);
  if (parentheses) amount = amount.slice(1, -1).trim();
  const match = /^(-)?\$?((?:\d+|\d{1,3}(?:,\d{3})+))(?:\.(\d{1,2}))?$/.exec(
    amount,
  );
  if (!match || (parentheses && match[1]))
    throw new Error(
      "Use a monetary amount with at most two decimal places; parentheses denote a negative amount.",
    );
  const cents =
    BigInt(match[2].replaceAll(",", "")) * 100n +
    BigInt((match[3] || "").padEnd(2, "0"));
  if (cents > 100_000_000_000n)
    throw new Error("Monetary amount exceeds the supported statement limit.");
  return Number(cents) * (parentheses || match[1] ? -1 : 1);
}
function date(value: string, format: StatementDateFormat) {
  if (AmsDate.safeParse(value).success) return value;
  const parts = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value);
  if (format === "iso" || !parts)
    throw new Error("Choose the file’s date format or use YYYY-MM-DD.");
  const month = format === "us" ? parts[1] : parts[2];
  const day = format === "us" ? parts[2] : parts[1];
  const normalized = `${parts[3]}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  if (!AmsDate.safeParse(normalized).success)
    throw new Error("Use a valid calendar date.");
  return normalized;
}
function transaction(value: string) {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
  const types: Record<string, string> = {
    nb: "new_business",
    new: "new_business",
    new_business: "new_business",
    rn: "renewal",
    renewal: "renewal",
    en: "endorsement",
    endorsement: "endorsement",
    cn: "cancellation",
    cancellation: "cancellation",
    adj: "adjustment",
    adjustment: "adjustment",
  };
  if (!Object.hasOwn(types, normalized))
    throw new Error(
      `Unknown transaction type “${value}”. Use new_business, renewal, endorsement, cancellation, or adjustment.`,
    );
  return types[normalized];
}
export function parseStatementCsv(
  text: string,
  options?: { mapping: StatementMapping; dateFormat: StatementDateFormat },
) {
  const { headers } = inspectStatementCsv(text);
  const rows = readCsvRows(text).slice(1);
  const templateKeys = statementColumns.filter((key) => key !== "paid_date");
  if (
    !options &&
    (headers.length !== templateKeys.length ||
      templateKeys.some(
        (key) => !headers.map((value) => value.toLowerCase()).includes(key),
      ))
  )
    throw new Error(
      "Use the carrier statement template headers, or review the column mapping.",
    );
  const mapping =
    options?.mapping ||
    (Object.fromEntries(
      statementColumns.map((key) => [
        key,
        headers.find((header) => header.toLowerCase() === key) || "",
      ]),
    ) as StatementMapping);
  for (const key of ["policy_number", "effective_date", "commission"] as const)
    if (!mapping[key])
      throw new Error(
        `Map ${columnLabels[key].toLowerCase()} before reviewing rows.`,
      );
  const selected = statementColumns.map((key) => mapping[key]).filter(Boolean);
  if (
    new Set(selected).size !== selected.length ||
    selected.some((header) => !headers.includes(header))
  )
    throw new Error(
      "Map each source column only once, using headers from this file.",
    );
  return rows.map((row, index) => {
    try {
      if (row.length !== headers.length)
        throw new Error("The number of fields does not match the header.");
      const get = (key: StatementColumn) =>
        mapping[key] ? row[headers.indexOf(mapping[key])].trim() : "";
      const parsedDate = (key: StatementColumn) =>
        get(key) ? date(get(key), options?.dateFormat || "iso") : null;
      if (!get("policy_number") || !get("effective_date") || !get("commission"))
        throw new Error(
          "Policy number, term effective date, and paid commission are required.",
        );
      return {
        id: crypto.randomUUID(),
        policyNumber: get("policy_number"),
        effectiveDate: date(
          get("effective_date"),
          options?.dateFormat || "iso",
        ),
        transactionDate: parsedDate("transaction_date"),
        paidDate: parsedDate("paid_date"),
        transaction: get("transaction")
          ? transaction(get("transaction"))
          : null,
        premiumCents: get("premium") ? statementMoney(get("premium")) : null,
        commissionCents: statementMoney(get("commission")),
      };
    } catch (error) {
      throw new Error(
        `Row ${index + 2}: ${error instanceof Error ? error.message : "Cannot read row."}`,
      );
    }
  });
}
