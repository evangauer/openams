/**
 * Seeds the demo agency's documents and filed emails: declarations pages for key
 * accounts, loss runs, an audit worksheet, notices, schedules as CSV, and emails that
 * arrived with attachments. All bytes are generated here and are fictional.
 */
import type { AmsActor } from "@openams/contracts";
import { calendarDays } from "./task-follow-up.js";
import { fileOriginalEmail } from "./correspondence.js";
import { verifiedFile, type AmsFiles } from "./files.js";
import type { AmsRepository } from "./repository.js";
import type { AmsService } from "./service.js";
import {
  csv,
  demoEmail,
  money,
  renderDemoPdf,
  type DemoPdf,
} from "./demo-files.js";

export interface DemoPolicyMeta {
  id: string;
  accountName: string;
  address: string;
  line: string;
  number: string;
  carrier: string;
  effectiveDate: string;
  expirationDate: string;
  premium: number;
  coverages: { name: string; limit?: string; deductible?: string }[];
}

type Category =
  | "policy"
  | "endorsement"
  | "application"
  | "certificate"
  | "claims"
  | "billing"
  | "correspondence"
  | "other";

const us = (date: string) => {
  const [y, m, d] = date.split("-");
  return `${m}/${d}/${y}`;
};

function declarations(p: DemoPolicyMeta): DemoPdf {
  return {
    issuer: p.carrier,
    title: `${p.line} · Declarations`,
    fields: [
      ["Policy number", p.number],
      ["Named insured", p.accountName],
      ["Mailing address", p.address],
      [
        "Policy period",
        `${us(p.effectiveDate)} to ${us(p.expirationDate)}, 12:01 a.m. standard time`,
      ],
      ["Producer", "Harbor Agency · Demo, White Plains, NY"],
      ["Total annual premium", money(p.premium)],
    ],
    tables: [
      {
        heading: "Coverages, limits and deductibles",
        head: ["Coverage", "Limit", "Deductible"],
        widths: [0.5, 0.3, 0.2],
        rows: p.coverages.map((c) => [
          c.name,
          c.limit ?? "Included",
          c.deductible ?? "None",
        ]),
      },
    ],
    paragraphs: [
      "This declarations page, together with the policy forms and endorsements, completes the policy. Fictional document generated for the OpenAMS demo.",
    ],
  };
}

export async function seedDemoFiles(input: {
  accounts: Map<string, string>;
  policyMeta: Map<string, DemoPolicyMeta>;
  date: string;
  at: Date;
  tenantId: string;
  actor: AmsActor;
  service: AmsService;
  repository: AmsRepository;
  files: AmsFiles;
  id: (key: string) => string;
  done: (key: string) => Promise<boolean>;
}) {
  const {
    accounts,
    policyMeta,
    date,
    at,
    tenantId,
    actor,
    service,
    files,
    id,
  } = input;
  const day = (offset: number) => us(calendarDays(date, offset));
  const policy = (account: string, line: string) =>
    policyMeta.get(`${account}:${line}`);

  const attach = async (
    key: string,
    account: string,
    name: string,
    bytes: Buffer,
    category: Category,
    description: string,
    line?: string,
  ) => {
    const commandId = id(`file:${key}`);
    if (await input.done(`file:${key}`)) return;
    const metadata = verifiedFile(name, bytes);
    const storageKey = `ams-documents/${tenantId}/${commandId}/${metadata.sha256}`;
    await files.put(storageKey, bytes, metadata.mediaType);
    await service.createDocument(actor, {
      id: commandId,
      action: "create",
      kind: "documents",
      reason: "Fictional walkthrough example; no external action.",
      data: {
        accountId: accounts.get(account)!,
        policyId: line ? (policy(account, line)?.id ?? null) : null,
        ...metadata,
        bytes: bytes.length,
        storageKey,
        category,
        supersedesId: null,
        description,
      },
    });
  };
  const pdf = (doc: DemoPdf) => renderDemoPdf(doc, at);

  // Declarations pages for the accounts a visitor is most likely to open.
  for (const account of [
    "midwest-freight",
    "lakeview-dental",
    "ridgeline-roofing",
    "thompson",
    "oakridge-apartments",
  ])
    for (const [key, meta] of policyMeta)
      if (key.startsWith(`${account}:`))
        await attach(
          `dec:${key}`,
          account,
          `${meta.line} declarations ${meta.number}.pdf`,
          await pdf(declarations(meta)),
          "policy",
          `Current-term declarations from ${meta.carrier}.`,
          meta.line,
        );

  // Hudson Freight: loss runs and schedules for the auto remarket.
  await attach(
    "freight:lossruns",
    "midwest-freight",
    "Loss runs 2021-2026 Northwoods Casualty.pdf",
    await pdf({
      issuer: "Northwoods Casualty",
      title: "Loss run report · Commercial auto",
      fields: [
        ["Insured", "Hudson Freight Partners Inc."],
        ["Valued as of", day(-9)],
        ["Report period", "5 policy years"],
      ],
      tables: [
        {
          head: [
            "Date of loss",
            "Claim #",
            "Description",
            "Status",
            "Paid",
            "Reserve",
          ],
          widths: [0.13, 0.17, 0.34, 0.1, 0.13, 0.13],
          rows: [
            [
              day(-19),
              "NWC-CA-26-55219",
              "Unit 9 rear-ended vehicle at light, I-287. BI claimed.",
              "Open",
              "$6,300",
              "$42,000",
            ],
            [
              day(-402),
              "NWC-CA-25-31877",
              "Backing into dock, damage to customer's door",
              "Closed",
              "$8,940",
              "$0",
            ],
            [
              day(-561),
              "NWC-CA-24-20415",
              "Sideswipe on NJ Turnpike; PD only",
              "Closed",
              "$14,210",
              "$0",
            ],
            [
              day(-950),
              "NWC-CA-23-11029",
              "Windshield / glass",
              "Closed",
              "$1,180",
              "$0",
            ],
          ],
        },
      ],
      paragraphs: [
        "Totals: 4 claims, paid $30,630, outstanding reserve $42,000, incurred $72,630.",
      ],
    }),
    "claims",
    "Five-year loss runs requested for the auto remarket.",
    "Commercial auto",
  );
  await attach(
    "freight:drivers",
    "midwest-freight",
    "Driver schedule.csv",
    csv([
      [
        "Driver",
        "License state",
        "Years CDL",
        "Violations (3 yr)",
        "Accidents (3 yr)",
        "Hire date",
      ],
      ["Dale Hoffman", "NY", 24, 0, 0, "2009-04-01"],
      ["Luis Ortega", "NY", 12, 0, 1, "2016-06-13"],
      ["Kevin Doyle", "NJ", 8, 1, 0, "2019-03-04"],
      ["Andre Mitchell", "NY", 15, 0, 0, "2018-09-17"],
      ["Paul Szymanski", "CT", 4, 0, 1, "2023-02-27"],
      ["Rosa Delgado", "NY", 10, 0, 0, "2021-08-09"],
      ["Tyler Brennan", "NY", 2, 1, 0, "2025-05-12"],
    ]),
    "application",
    "Current driver list with MVR summary for underwriters.",
    "Commercial auto",
  );
  await attach(
    "freight:vehicles",
    "midwest-freight",
    "Vehicle schedule.csv",
    csv([
      [
        "Unit",
        "Year",
        "Make / model",
        "VIN (fictional)",
        "Stated value",
        "Radius",
      ],
      ...Array.from({ length: 14 }, (_, i) => [
        i + 1,
        2017 + (i % 8),
        i % 3 ? "Freightliner Cascadia" : "Volvo VNL 760",
        `DEMO${String(100000 + i * 7919).slice(0, 6)}FAKEVIN${i}`,
        65000 + (i % 8) * 9000,
        "500 miles",
      ]),
    ]),
    "application",
    "Power units on the commercial auto policy.",
    "Commercial auto",
  );

  // Lakeview Dental: renewal proposal and a signed application.
  await attach(
    "dental:proposal",
    "lakeview-dental",
    "Renewal proposal 2027 Lakeview Family Dental.pdf",
    await pdf({
      issuer: "Harbor Agency · Demo",
      title: "Renewal proposal",
      fields: [
        ["Prepared for", "Dr. Priya Raman, Lakeview Family Dental, S.C."],
        ["Prepared by", "Alex Morgan"],
        ["Proposal date", day(0)],
      ],
      tables: [
        {
          head: ["Coverage", "Carrier", "Expiring", "Renewal", "Change"],
          widths: [0.3, 0.25, 0.15, 0.15, 0.15],
          rows: [
            [
              "Business owners",
              "Lakeshore Mutual",
              "$4,410",
              "$4,860",
              "+10.2%",
            ],
            [
              "Workers compensation",
              "Adirondack Comp Group",
              "$6,240",
              "$6,240",
              "0%",
            ],
            [
              "NY disability & PFL",
              "Adirondack Comp Group",
              "$380",
              "$380",
              "0%",
            ],
            [
              "Professional liability",
              "Riverbend Indemnity",
              "$3,980",
              "$3,980",
              "0%",
            ],
            ["Cyber", "Summit Specialty (E&S)", "$2,150", "$2,150", "0%"],
            ["Option: EPLI $500K", "Riverbend Indemnity", "—", "$1,240", "New"],
          ],
        },
      ],
      paragraphs: [
        "The business owners increase reflects the updated building replacement cost valuation. We recommend adding employment practices liability with the new hire planned for Q1.",
      ],
    }),
    "other",
    "Proposal to present at the renewal meeting.",
  );
  await attach(
    "dental:cyberapp",
    "lakeview-dental",
    "Cyber application signed.pdf",
    await pdf({
      issuer: "Summit Specialty (E&S)",
      title: "Cyber liability renewal application",
      fields: [
        ["Applicant", "Lakeview Family Dental, S.C."],
        ["Annual revenue", "$3,400,000"],
        ["Patient records held", "Approximately 9,800"],
        ["Signed", `Dr. Priya Raman, ${day(-6)}`],
      ],
      tables: [
        {
          head: ["Control", "Answer"],
          widths: [0.75, 0.25],
          rows: [
            ["Multi-factor authentication on email and remote access", "Yes"],
            ["Offline or immutable backups tested in last 6 months", "Yes"],
            ["Endpoint detection and response on all devices", "Yes"],
            ["Security awareness training for staff", "Annual"],
            ["Any cyber incident in the past 3 years", "No"],
          ],
        },
      ],
    }),
    "application",
    "Signed renewal application.",
    "Cyber",
  );

  // Ridgeline: audit worksheet and subcontractor certificates.
  const subCoi = (name: string, insured: string) =>
    pdf({
      issuer: "Certificate of liability insurance",
      title: `Certificate of insurance · ${insured}`,
      fields: [
        ["Insured", insured],
        [
          "Certificate holder",
          "Ridgeline Roofing & Exteriors LLC, 1125 Nepperhan Ave, Yonkers, NY 10703",
        ],
        ["Date issued", day(-4)],
      ],
      tables: [
        {
          head: ["Type", "Policy #", "Effective", "Expires", "Limits"],
          widths: [0.24, 0.2, 0.14, 0.14, 0.28],
          rows: [
            [
              "General liability",
              `GL-${name}-2201`,
              day(-200),
              day(165),
              "$1M occ / $2M agg",
            ],
            [
              "Workers compensation",
              `WC-${name}-5590`,
              day(-200),
              day(165),
              "Statutory (NY)",
            ],
          ],
        },
      ],
      paragraphs: [
        "This certificate is issued as a matter of information only. Fictional demo document.",
      ],
    });
  await attach(
    "roof:audit",
    "ridgeline-roofing",
    "WC premium audit worksheet.pdf",
    await pdf({
      issuer: "Adirondack Comp Group",
      title: "Workers compensation premium audit · Preliminary",
      fields: [
        ["Insured", "Ridgeline Roofing & Exteriors LLC"],
        ["Audit period", `${day(-468)} to ${day(-103)}`],
        ["Response due", day(7)],
      ],
      tables: [
        {
          head: [
            "Class",
            "Description",
            "Estimated payroll",
            "Audited payroll",
            "Rate",
            "Premium change",
          ],
          widths: [0.1, 0.3, 0.15, 0.15, 0.12, 0.18],
          rows: [
            [
              "5551",
              "Roofing, all kinds",
              "$640,000",
              "$652,400",
              "8.21",
              "+$1,018",
            ],
            ["8810", "Clerical", "$62,000", "$64,100", "0.19", "+$4"],
            [
              "5551",
              "Uninsured subcontractors",
              "$0",
              "$85,000",
              "8.21",
              "+$6,979",
            ],
          ],
        },
      ],
      paragraphs: [
        "Payments to subcontractors without evidence of workers compensation coverage are included as payroll. Provide certificates of insurance for the subcontractors below to have their payroll removed.",
      ],
    }),
    "billing",
    "Auditor added $85,000 of subcontractor payroll. Disputing with certificates.",
    "Workers compensation",
  );
  const apex = await subCoi("APX", "Apex Gutters Inc.");
  const summitSiding = await subCoi("SSD", "Hudson Siding Pros LLC");
  await attach(
    "roof:coi1",
    "ridgeline-roofing",
    "Subcontractor COI Apex Gutters.pdf",
    apex,
    "certificate",
    "Sub certificate for the audit dispute.",
    "Workers compensation",
  );

  // Thompson household: hail claim estimate and remarket comparison.
  await attach(
    "thompson:estimate",
    "thompson",
    "Hail claim adjuster estimate.pdf",
    await pdf({
      issuer: "Lakeshore Mutual · Claims",
      title: "Property loss estimate",
      fields: [
        ["Claim number", "LM-HO-26-118402"],
        ["Insured", "Mark & Julie Thompson"],
        ["Date of loss", day(-210)],
        ["Adjuster", "K. Barrett"],
      ],
      tables: [
        {
          head: ["Item", "Quantity", "Replacement cost"],
          widths: [0.6, 0.15, 0.25],
          rows: [
            [
              "Remove and replace architectural shingles",
              "32 sq",
              "$13,440.00",
            ],
            ["Ice and water shield", "6 sq", "$1,260.00"],
            ["Gutters and downspouts, aluminum", "180 lf", "$2,520.00"],
            ["Window screens", "6", "$480.00"],
            ["Less deductible", "", "-$1,000.00"],
          ],
        },
      ],
      paragraphs: [
        "Net claim: $16,700.00. Paid to date $14,200.00; depreciation holdback released on proof of completion.",
      ],
    }),
    "claims",
    "Adjuster's estimate for the roof claim.",
    "Homeowners",
  );
  await attach(
    "thompson:compare",
    "thompson",
    "Package remarket comparison.pdf",
    await pdf({
      issuer: "Harbor Agency · Demo",
      title: "Home, auto and umbrella · Market comparison",
      fields: [
        ["Prepared for", "Mark & Julie Thompson"],
        ["Date", day(-1)],
      ],
      tables: [
        {
          head: ["", "Lakeshore (renewal)", "Finger Lakes", "Taconic Mutual"],
          rows: [
            ["Homeowners", "$2,940", "$2,610", "$2,480"],
            ["Auto (3 vehicles)", "$3,260", "$3,390", "$3,520"],
            ["Umbrella $1M", "$410", "$385", "$440"],
            ["Total", "$6,610", "$6,385", "$6,440"],
            ["Roof deductible", "$1,000", "2% wind/hail", "$2,500"],
          ],
        },
      ],
      paragraphs: [
        "Recommendation: Finger Lakes package saves $225 but adds a percentage wind/hail deductible. Review with the clients before binding.",
      ],
    }),
    "other",
    "Comparison to review on today's call.",
  );

  // Miller: non-payment notice. Nguyen: mortgagee change. Sunrise: claim invoice.
  const notice = await pdf({
    issuer: "Riverbend Indemnity",
    title: "Notice of cancellation for nonpayment of premium",
    fields: [
      ["Named insured", "Jessica Miller"],
      ["Policy", policy("miller", "Personal auto")?.number ?? "Personal auto"],
      ["Amount due", "$412.18"],
      ["Cancellation effective", `${day(10)} at 12:01 a.m.`],
    ],
    paragraphs: [
      "Your policy will be cancelled on the date shown unless the amount due is received before that date. If payment is received, your policy will continue without interruption.",
    ],
  });
  await attach(
    "miller:notice",
    "miller",
    "Notice of cancellation nonpayment.pdf",
    notice,
    "billing",
    "Carrier NOC. Call client today.",
    "Personal auto",
  );
  await attach(
    "nguyen:mortgagee",
    "nguyen",
    "Mortgagee change request Example Home Lending.pdf",
    await pdf({
      issuer: "Example Home Lending",
      title: "Request to update mortgagee clause",
      fields: [
        ["Borrowers", "Linh Nguyen and David Nguyen"],
        ["Property", "42 Mill Rd, Eastchester, NY 10709"],
        ["Loan number", "DEMO-88310427"],
        [
          "New mortgagee clause",
          "Example Home Lending ISAOA/ATIMA, PO Box 5000, Fictional, NY 10001",
        ],
      ],
      paragraphs: [
        "Please update the homeowners policy and send evidence of insurance showing the new mortgagee to the address above.",
      ],
    }),
    "endorsement",
    "Lender request after refinance.",
    "Homeowners",
  );
  await attach(
    "sunrise:invoice",
    "sunrise-bakery",
    "Walk-in cooler repair invoice.pdf",
    await pdf({
      issuer: "Westchester Refrigeration Service",
      title: "Service invoice",
      fields: [
        ["Customer", "Sunrise Bakery & Café"],
        ["Service date", day(-3)],
        ["Invoice", "WRS-20418"],
      ],
      tables: [
        {
          head: ["Description", "Amount"],
          widths: [0.75, 0.25],
          rows: [
            ["Emergency call, after hours", "$295.00"],
            ["Replace compressor contactor and start capacitor", "$640.00"],
            ["Refrigerant recharge", "$410.00"],
            ["Total", "$1,345.00"],
          ],
        },
      ],
    }),
    "claims",
    "Repair invoice for the spoilage claim.",
    "Business owners",
  );

  // Emails that arrived with attachments, filed to the account.
  const email = async (
    key: string,
    account: string,
    line: string | undefined,
    message: Parameters<typeof demoEmail>[0],
  ) => {
    if (await input.done(`mail:${key}`)) return;
    const current = (await input.repository.get(
      tenantId,
      "accounts",
      accounts.get(account)!,
    ))!;
    await fileOriginalEmail({
      actor,
      accountId: current.id,
      filing: {
        commandId: id(`mail:${key}`),
        expectedVersion: current.version,
        policyId: line ? (policy(account, line)?.id ?? null) : null,
        direction: "inbound",
        shareWithAgency: true,
      },
      bytes: demoEmail(message),
      filename: `${key}.eml`,
      repository: input.repository,
      files,
      service,
    });
  };
  const hoursAgo = (hours: number) =>
    new Date(at.getTime() - hours * 3_600_000);
  await email("freight-unit15", "midwest-freight", "Commercial auto", {
    from: "Angie Kowalski <angie@hudsonfreight.example.test>",
    to: "Sam Rivera <manager@harbor.example.test>",
    subject: "Add unit 15 – bill of sale attached",
    date: hoursAgo(3),
    messageId: `${id("mail:freight-unit15")}@demo.example.test`,
    body: "Hi Sam,\n\nWe take delivery of the new Cascadia Friday. Bill of sale is attached with the VIN. Please add it to the auto policy effective on delivery and send me an updated auto ID card.\n\nThanks,\nAngie",
    attachments: [
      {
        name: "Bill of sale unit 15.pdf",
        type: "application/pdf",
        bytes: await pdf({
          issuer: "Tri-State Truck Center",
          title: "Bill of sale",
          fields: [
            ["Buyer", "Hudson Freight Partners Inc."],
            ["Vehicle", "2025 Freightliner Cascadia 126"],
            ["VIN (fictional)", "DEMO3AKJHHDR5SFAKE15"],
            ["Price", "$168,500.00"],
            ["Delivery date", day(2)],
          ],
        }),
      },
    ],
  });
  await email("roof-subs", "ridgeline-roofing", "Workers compensation", {
    from: "Lisa Brandt <lisa@ridgelineroofing.example.test>",
    to: "Sam Rivera <manager@harbor.example.test>",
    subject: "RE: Audit – sub certificates",
    date: hoursAgo(26),
    messageId: `${id("mail:roof-subs")}@demo.example.test`,
    body: "Sam,\n\nAttached are COIs for Apex Gutters and Hudson Siding Pros. Still waiting on the other three subs, I'll chase them this week.\n\nLisa",
    attachments: [
      { name: "Apex Gutters COI.pdf", type: "application/pdf", bytes: apex },
      {
        name: "Hudson Siding Pros COI.pdf",
        type: "application/pdf",
        bytes: summitSiding,
      },
    ],
  });
  await email("miller-noc", "miller", "Personal auto", {
    from: "Jessica Miller <jessica.miller@mail.example.test>",
    to: "Jordan Parker <member@harbor.example.test>",
    subject: "Got this letter in the mail??",
    date: hoursAgo(2),
    messageId: `${id("mail:miller-noc")}@demo.example.test`,
    body: "Hi Jordan,\n\nI got the attached letter saying my car insurance is being cancelled. I thought autopay was on. Can you help me figure out what happened?\n\nJessica",
    attachments: [
      { name: "Riverbend letter.pdf", type: "application/pdf", bytes: notice },
    ],
  });
}
