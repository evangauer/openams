import type { AmsRecord } from "@openams/contracts";
import { amsCalendarDate } from "@openams/contracts";
export interface CertificateField {
  pdfKey: string;
  type: "text" | "checkbox";
  label: string;
  section: string;
}
const date = (value: string) =>
  value
    ? `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}`
    : "";
const address = (value: Record<string, string>) =>
  [
    value.line1,
    value.line2,
    [value.city, value.state, value.postalCode].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join("\n");
const wc =
  "ANY PROPRIETORPARTNEREXECUTIVE OFFICERMEMBER EXCLUDED WORKERS COMPENSATION AND EMPLOYERS LIABILITY If yes describe under SPECIAL PROVISIONS below";
export function certificateDefaults(
  certificate: AmsRecord<"certificates">,
  account: AmsRecord<"accounts">,
  policies: AmsRecord<"policies">[],
  agency: string,
  timeZone = "UTC",
) {
  const values: Record<string, string | boolean> = {
    "Date Top": date(amsCalendarDate(new Date(), timeZone)),
    PRODUCER: agency,
    INSURED: [
      account.data.legalName || account.data.name,
      address(account.data.address),
    ]
      .filter(Boolean)
      .join("\n"),
    "Certificat Holder": [
      certificate.data.holderName,
      address(certificate.data.holderAddress),
    ]
      .filter(Boolean)
      .join("\n"),
    "DESCRIPTION OF OPERATIONS  LOCATIONS  VEHICLES  EXCLUSIONS ADDED BY ENDORSEMENT  SPECIAL PROVISIONS":
      certificate.data.description,
  };
  const carriers = [...new Set(policies.map((p) => p.data.carrier))].slice(
    0,
    5,
  );
  carriers.forEach((carrier, index) => {
    values[`Insurer ${String.fromCharCode(65 + index)} Coverage`] = carrier;
  });
  // Only unambiguous lines with a single selected term are prefilled. Limits,
  // additional-insured assertions, cancellation promises and signatures are reviewed manually.
  const categories = [
    {
      match: /^(general liability|commercial general liability|gl|cgl)$/i,
      number: "POLICY NUMBERRow1",
      effective: "EACH OCCURRENCE Effective Date",
      expiration: "Each Occurrence Expiration Date",
      letter: "INSR LTRRow1",
    },
    {
      match: /^(commercial auto|auto liability|business auto)$/i,
      number: "POLICY NUMBERRow2",
      effective: "COMBINED SINGLE LIMIT Effective Date",
      expiration: "COMBINED SINGLE LIMIT Expiration Date",
      letter: "INSR LTRRow2",
    },
    {
      match: /^(umbrella|excess|excess liability|commercial umbrella)$/i,
      number: "POLICY NUMBERRow4",
      effective: "EACH OCCURRENCE_2",
      expiration: "",
      letter: "INSR LTRRow4",
    },
    {
      match: /^(workers compensation|workers' compensation|workers comp|wc)$/i,
      number: `POLICY NUMBER${wc}`,
      effective: `POLICY EFFECTIVE DATE MMDDYY${wc}`,
      expiration: `POLICY EXPIRATION DATE MMDDYY${wc}`,
      letter: "INSR LTRRow5",
    },
  ];
  for (const category of categories) {
    const matches = policies.filter((p) =>
      category.match.test(p.data.line.trim()),
    );
    if (matches.length !== 1) continue;
    const policy = matches[0].data;
    values[category.number] = policy.number;
    values[category.effective] = category.expiration
      ? date(policy.effectiveDate)
      : `${date(policy.effectiveDate)}  ${date(policy.expirationDate)}`;
    if (category.expiration)
      values[category.expiration] = date(policy.expirationDate);
    const insurer = carriers.indexOf(policy.carrier);
    if (insurer >= 0)
      values[category.letter] = String.fromCharCode(65 + insurer);
  }
  return values;
}
