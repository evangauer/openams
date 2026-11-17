export const importKinds = ["accounts", "policies", "contacts", "exposures", "notes", "tasks"] as const;
export type ImportKind = (typeof importKinds)[number];
/** Resolve a DOM value to a trusted option before using it in paths or templates. */
export function importKindFromValue(value: unknown): ImportKind | null {
  return importKinds.find((kind) => kind === value) ?? null;
}
const attributionHeaders = [
  "external_id",
  "account_external_id",
  "source_created_at",
  "source_author",
];
const addressHeaders = ["address", "city", "state", "zip"];
const policyLinkHeaders = [
  "policy_number",
  "policy_carrier",
  "policy_effective_date",
];
const contactHeaders = [
  ...attributionHeaders,
  "name",
  "title",
  "email",
  "phone",
  "mobile",
  "primary",
  ...addressHeaders,
  "notes",
];
const exposureHeaders = [
  ...attributionHeaders,
  "kind",
  "name",
  ...addressHeaders,
  "description",
  "values_json",
];
const noteHeaders = [
  ...attributionHeaders,
  ...policyLinkHeaders,
  "body",
  "category",
  "occurred_at",
];
const taskHeaders = [
  ...attributionHeaders,
  ...policyLinkHeaders,
  "title",
  "description",
  "due_date",
  "priority",
];
const accountHeaders = [
  "external_id",
  "name",
  "legal_name",
  "dba",
  "status",
  "industry",
  "naics",
  "email",
  "phone",
  "website",
  "address",
  "city",
  "state",
  "zip",
];
const policyHeaders = [
  "account_external_id",
  "policy_number",
  "line",
  "carrier",
  "effective_date",
  "expiration_date",
  "billing",
  "premium",
  "tax",
  "fee",
  "commission_rate",
];
export const importTemplates: Record<ImportKind, string> = {
  accounts:
    accountHeaders.join(",") +
    "\nexample-001,Example Manufacturing,Example Manufacturing LLC,,active,Manufacturing,332710,office@example.test,555-0100,,100 Example Way,Columbus,OH,43215\n",
  policies:
    policyHeaders.join(",") +
    "\nexample-001,EXAMPLE-GL-001,General liability,Example Mutual,2026-01-01,2027-01-01,direct,12500,0,0,15\n",
  contacts:
    contactHeaders.join(",") +
    "\ncontact-001,example-001,2025-01-10T15:00:00Z,Previous team,Jordan Example,Office manager,jordan@example.test,555-0101,,true,100 Example Way,Columbus,OH,43215,Primary renewal contact\n",
  exposures:
    exposureHeaders.join(",") +
    '\nlocation-001,example-001,2025-01-10T15:00:00Z,Previous team,location,Main workshop,100 Example Way,Columbus,OH,43215,Manufacturing operations,"{""squareFeet"":5000}"\n',
  notes:
    noteHeaders.join(",") +
    "\nnote-001,example-001,2025-01-10T15:00:00Z,Previous team,,,,Discussed renewal exposures,call,2025-01-10T15:00:00Z\n",
  tasks:
    taskHeaders.join(",") +
    "\ntask-001,example-001,2026-11-01T15:00:00Z,Previous team,,,,Request updated payroll,Confirm figures with office manager,2026-12-01,normal\n",
};
export function readCsvRows(text: string): string[][] {
  if (text.length > 200_000)
    throw new Error(
      "Use a CSV under 200 KB and at most 250 rows per reviewed batch.",
    );
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const pushCell = () => {
    row.push(cell.trim());
    cell = "";
    closed = false;
  };
  for (let index = 0; index < source.length; index++) {
    const ch = source[index];
    if (quoted) {
      if (ch === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += ch;
      continue;
    }
    if (ch === "," || ch === "\n") {
      pushCell();
      if (ch === "\n") {
        if (row.some(Boolean)) rows.push(row);
        row = [];
      }
      continue;
    }
    if (ch === '"' && !cell && !closed) {
      quoted = true;
      continue;
    }
    if (ch === '"' || (closed && !/\s/.test(ch)))
      throw new Error(
        "Invalid CSV quoting. Use the template and quote fields containing commas.",
      );
    if (!closed) cell += ch;
  }
  if (quoted) throw new Error("The CSV contains an unclosed quoted field.");
  pushCell();
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
export function parseImportCsv(
  text: string,
  kind: ImportKind,
): Record<string, unknown>[] {
  const rows = readCsvRows(text);
  const headers = rows.shift()?.map((value) => value.toLowerCase());
  const allowed = {
    accounts: accountHeaders,
    policies: policyHeaders,
    contacts: contactHeaders,
    exposures: exposureHeaders,
    notes: noteHeaders,
    tasks: taskHeaders,
  }[kind];
  const required =
    kind === "accounts"
      ? ["external_id", "name"]
      : kind === "policies"
        ? [
            "account_external_id",
            "policy_number",
            "line",
            "carrier",
            "effective_date",
            "expiration_date",
            "premium",
          ]
        : [
            "external_id",
            "account_external_id",
            ...{
              contacts: ["name"],
              exposures: ["kind", "name"],
              notes: ["body", "occurred_at"],
              tasks: ["title", "due_date"],
            }[kind],
          ];
  if (
    !headers ||
    new Set(headers).size !== headers.length ||
    headers.some((header) => !allowed.includes(header)) ||
    required.some((header) => !headers.includes(header))
  )
    throw new Error(
      `Use the ${kind} template headers. Required: ${required.join(", ")}.`,
    );
  if (!rows.length || rows.length > 250)
    throw new Error("Use between 1 and 250 records per import.");
  return rows.map((values, index) => {
    if (values.length !== headers.length)
      throw new Error(
        `Row ${index + 2} has ${values.length} fields; expected ${headers.length}.`,
      );
    const r = Object.fromEntries(
      headers.map((header, i) => [header, values[i]]),
    );
    if (kind === "accounts")
      return {
        externalId: r.external_id,
        name: r.name,
        legalName: r.legal_name || "",
        dba: r.dba || "",
        status: r.status || "prospect",
        industry: r.industry || "",
        naics: r.naics || "",
        email: r.email || "",
        phone: r.phone || "",
        website: r.website || "",
        address: {
          line1: r.address || "",
          city: r.city || "",
          state: r.state || "",
          postalCode: r.zip || "",
          country: "US",
        },
      };
    if (kind !== "policies") {
      const common = {
        externalId: r.external_id,
        accountExternalId: r.account_external_id,
        sourceCreatedAt: r.source_created_at || null,
        sourceAuthor: r.source_author || "",
      };
      const address = {
        line1: r.address || "",
        city: r.city || "",
        state: r.state || "",
        postalCode: r.zip || "",
        country: "US",
      };
      const policy = {
        policyNumber: r.policy_number || "",
        policyCarrier: r.policy_carrier || "",
        policyEffectiveDate: r.policy_effective_date || "",
      };
      if (kind === "contacts") {
        if (r.primary && !["true", "false"].includes(r.primary.toLowerCase()))
          throw new Error(`Row ${index + 2}: primary must be true or false.`);
        return {
          ...common,
          name: r.name,
          title: r.title || "",
          email: r.email || "",
          phone: r.phone || "",
          mobile: r.mobile || "",
          primary: r.primary?.toLowerCase() === "true",
          address,
          notes: r.notes || "",
        };
      }
      if (kind === "exposures") {
        let values: unknown;
        try {
          values = JSON.parse(r.values_json || "{}");
        } catch {
          throw new Error(
            `Row ${index + 2}: values_json must contain a valid JSON object.`,
          );
        }
        if (!values || typeof values !== "object" || Array.isArray(values))
          throw new Error(
            `Row ${index + 2}: values_json must contain a JSON object.`,
          );
        return {
          ...common,
          kind: r.kind,
          name: r.name,
          address,
          description: r.description || "",
          values,
        };
      }
      if (kind === "notes")
        return {
          ...common,
          ...policy,
          body: r.body,
          category: r.category || "note",
          occurredAt: r.occurred_at,
        };
      return {
        ...common,
        ...policy,
        title: r.title,
        description: r.description || "",
        dueDate: r.due_date,
        priority: r.priority || "normal",
      };
    }
    const decimal = (key: string) => {
      const raw = r[key] || "0";
      if (!/^-?\d+(\.\d{1,2})?$/.test(raw))
        throw new Error(
          `Row ${index + 2}: ${key} must be a plain number with at most two decimal places, without currency symbols.`,
        );
      return Math.round(Number(raw) * 100);
    };
    return {
      accountExternalId: r.account_external_id,
      number: r.policy_number,
      line: r.line,
      carrier: r.carrier,
      effectiveDate: r.effective_date,
      expirationDate: r.expiration_date,
      billing: r.billing || "direct",
      premiumCents: decimal("premium"),
      taxCents: decimal("tax"),
      feeCents: decimal("fee"),
      commissionBps: decimal("commission_rate"),
    };
  });
}
