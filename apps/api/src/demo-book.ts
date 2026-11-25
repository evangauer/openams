/**
 * The demo agency's book of business: a fictional independent agency of about forty
 * households and small businesses, sized so lists, renewals and premium totals read
 * like a real book. Every name, address, carrier and number here is invented.
 *
 * Dates are offsets in days from the day the demo is opened, so the renewal pipeline
 * always spans the next few months.
 */

let householdIndex = 0;

/** Teammates by role, resolved to member ids when the demo is seeded. */
export type DemoOwner = "admin" | "manager" | "member" | "accountant";

export const DEMO_CARRIERS = {
  lakeshore: "Lakeshore Mutual",
  prairie: "Finger Lakes Insurance",
  northwoods: "Northwoods Casualty",
  badger: "Taconic Mutual",
  summit: "Summit Specialty (E&S)",
  comp: "Adirondack Comp Group",
  riverbend: "Riverbend Indemnity",
} as const;
export type DemoCarrier = keyof typeof DEMO_CARRIERS;

type Coverage = { name: string; limit?: string; deductible?: string };

/** Typical coverage lines per line of business, so each policy has believable terms. */
export const DEMO_COVERAGES: Record<string, Coverage[]> = {
  "Personal auto": [
    { name: "Bodily injury liability", limit: "$250,000 / $500,000" },
    { name: "No-fault (PIP)", limit: "$50,000" },
    {
      name: "Supplementary uninsured / underinsured (SUM)",
      limit: "$250,000 / $500,000",
    },
    { name: "Property damage liability", limit: "$100,000" },
    { name: "Collision", deductible: "$500" },
    { name: "Comprehensive", deductible: "$250" },
  ],
  Homeowners: [
    { name: "Dwelling", limit: "$425,000", deductible: "$1,000" },
    { name: "Other structures", limit: "$42,500" },
    { name: "Personal property", limit: "$297,500" },
    { name: "Personal liability", limit: "$300,000" },
    { name: "Water backup", limit: "$10,000" },
  ],
  Condo: [
    { name: "Unit improvements", limit: "$60,000", deductible: "$1,000" },
    { name: "Personal property", limit: "$75,000" },
    { name: "Loss assessment", limit: "$25,000" },
    { name: "Personal liability", limit: "$300,000" },
  ],
  Renters: [
    { name: "Personal property", limit: "$30,000", deductible: "$500" },
    { name: "Personal liability", limit: "$100,000" },
  ],
  "Personal umbrella": [
    { name: "Each occurrence", limit: "$1,000,000" },
    { name: "Retained limit", deductible: "$0" },
  ],
  Flood: [
    { name: "Building", limit: "$250,000", deductible: "$2,000" },
    { name: "Contents", limit: "$100,000", deductible: "$2,000" },
  ],
  "Dwelling fire": [
    { name: "Dwelling", limit: "$310,000", deductible: "$2,500" },
    { name: "Fair rental value", limit: "$31,000" },
    { name: "Premises liability", limit: "$500,000" },
  ],
  Boat: [
    { name: "Hull", limit: "$48,000", deductible: "$1,000" },
    { name: "Liability", limit: "$300,000" },
  ],
  "Business owners": [
    { name: "Building", limit: "$850,000", deductible: "$2,500" },
    { name: "Business personal property", limit: "$180,000" },
    { name: "Business income", limit: "Actual loss sustained, 12 months" },
    { name: "Each occurrence", limit: "$1,000,000" },
    { name: "General aggregate", limit: "$2,000,000" },
  ],
  "General liability": [
    { name: "Each occurrence", limit: "$1,000,000", deductible: "$1,000" },
    { name: "General aggregate", limit: "$2,000,000" },
    { name: "Products / completed operations", limit: "$2,000,000" },
    { name: "Damage to rented premises", limit: "$100,000" },
  ],
  "Workers compensation": [
    { name: "Workers compensation", limit: "Statutory (NY)" },
    { name: "Employers liability, each accident", limit: "$500,000" },
    { name: "Employers liability, disease each employee", limit: "$500,000" },
  ],
  "Commercial auto": [
    { name: "Combined single limit", limit: "$1,000,000" },
    { name: "No-fault (PIP)", limit: "$50,000" },
    { name: "Hired and non-owned auto", limit: "$1,000,000" },
    { name: "Collision", deductible: "$1,000" },
    { name: "Comprehensive", deductible: "$500" },
  ],
  "Commercial property": [
    { name: "Building", limit: "$2,400,000", deductible: "$5,000" },
    { name: "Business personal property", limit: "$350,000" },
    { name: "Business income", limit: "$500,000" },
  ],
  "Commercial umbrella": [
    { name: "Each occurrence", limit: "$5,000,000" },
    { name: "Aggregate", limit: "$5,000,000" },
  ],
  "Inland marine": [
    { name: "Contractors equipment", limit: "$185,000", deductible: "$1,000" },
    { name: "Rented equipment", limit: "$50,000" },
  ],
  "Professional liability": [
    { name: "Each claim", limit: "$1,000,000", deductible: "$5,000" },
    { name: "Aggregate", limit: "$2,000,000" },
  ],
  Cyber: [
    { name: "Aggregate", limit: "$1,000,000", deductible: "$2,500" },
    { name: "Ransomware / extortion", limit: "$500,000" },
    { name: "Business interruption", limit: "$500,000" },
  ],
  "Liquor liability": [
    { name: "Each common cause", limit: "$1,000,000" },
    { name: "Aggregate", limit: "$2,000,000" },
  ],
  "NY disability & paid family leave": [
    { name: "Statutory disability (DBL)", limit: "Statutory (NY)" },
    { name: "Paid family leave (PFL)", limit: "Statutory (NY)" },
  ],
  "Directors & officers": [
    { name: "Each claim", limit: "$1,000,000", deductible: "$1,000" },
  ],
};

/** Policy number formats that resemble carriers' own, per carrier. */
const NUMBER_FORMATS: Record<DemoCarrier, (n: string, line: string) => string> =
  {
    lakeshore: (n, line) => `${abbreviation(line)}-${n.slice(0, 7)}`,
    prairie: (n) => `PSI ${n.slice(0, 3)}-${n.slice(3, 9)}`,
    northwoods: (n, line) =>
      `NWC${abbreviation(line)}${n.slice(0, 2)}-${n.slice(2, 7)}`,
    badger: (n) => `BVM${n.slice(0, 8)}`,
    summit: (n) => `SSE-${n.slice(0, 2)}-${n.slice(2, 7)}`,
    comp: (n) => `WC ${n.slice(0, 4)}-${n.slice(4, 8)}`,
    riverbend: (n, line) =>
      `${abbreviation(line)} ${n.slice(0, 4)} ${n.slice(4, 8)}`,
  };
function abbreviation(line: string) {
  return (
    {
      "Personal auto": "PA",
      Homeowners: "HO",
      Condo: "HO6",
      Renters: "HO4",
      "Personal umbrella": "PUP",
      Flood: "FL",
      "Dwelling fire": "DP",
      Boat: "BT",
      "Business owners": "BOP",
      "General liability": "GL",
      "Workers compensation": "WC",
      "Commercial auto": "CA",
      "Commercial property": "CP",
      "Commercial umbrella": "CU",
      "Inland marine": "IM",
      "Professional liability": "PL",
      Cyber: "CY",
      "Liquor liability": "LL",
      "Directors & officers": "DO",
      "NY disability & paid family leave": "DBL",
    }[line] ?? "XX"
  );
}
export function demoPolicyNumber(
  carrier: DemoCarrier,
  line: string,
  digits: string,
) {
  return NUMBER_FORMATS[carrier](digits, line);
}

export interface DemoPolicy {
  line: string;
  carrier: DemoCarrier;
  /** Annual premium in dollars. */
  premium: number;
  /** Commission percent. */
  commission: number;
  /** Days from today until this term expires. */
  expires: number;
  billing?: "direct" | "agency";
  /** A prior, expired term with this premium, so the policy has history. */
  priorPremium?: number;
  /** A prior term with another carrier (the account moved at last renewal). */
  priorCarrier?: DemoCarrier;
}
export interface DemoAccount {
  key: string;
  name: string;
  type: "person" | "business";
  legalName?: string;
  industry?: string;
  city: string;
  street: string;
  postalCode: string;
  phone: string;
  email: string;
  website?: string;
  producer: DemoOwner;
  service: DemoOwner;
  status?: "active" | "prospect";
  source?: string;
  tags?: string[];
  notes?: string;
  contacts: { name: string; title?: string; email?: string; phone?: string }[];
  exposures?: {
    kind:
      | "location"
      | "building"
      | "vehicle"
      | "driver"
      | "payroll"
      | "equipment"
      | "operations";
    name: string;
    values: Record<string, string | number | boolean>;
  }[];
  policies: DemoPolicy[];
  /** Renewal stage overrides keyed by the expiration offset of its policies. */
  renewal?: {
    stage?: "review" | "collecting" | "marketing" | "proposal" | "waiting";
    nextAction: string;
    waitingOn?: string;
    followUp?: number;
    notes?: string;
  };
}

/**
 * Households (personal lines) and small businesses (commercial lines). Alex is the
 * principal and lead producer, Sam manages commercial accounts, Jordan services
 * personal lines.
 */
export const DEMO_BOOK: DemoAccount[] = [
  // ---------------------------------------------------------------- Commercial
  {
    key: "lakeview-dental",
    name: "Lakeview Family Dental",
    legalName: "Lakeview Family Dental, S.C.",
    type: "business",
    industry: "Dental office",
    city: "Scarsdale",
    street: "700 White Plains Rd, Suite 210",
    postalCode: "10583",
    phone: "555-0161",
    email: "office@lakeviewdental.example.test",
    website: "https://lakeviewdental.example.test",
    producer: "admin",
    service: "manager",
    source: "Referral (CPA)",
    tags: ["Medical", "Key account"],
    contacts: [
      { name: "Dr. Priya Raman", title: "Owner, DDS" },
      { name: "Kelsey Ortiz", title: "Practice manager" },
    ],
    exposures: [
      {
        kind: "location",
        name: "Leased office suite",
        values: {
          squareFeet: 3100,
          construction: "Joisted masonry",
          sprinklered: true,
        },
      },
      {
        kind: "payroll",
        name: "Staff",
        values: { employees: 14, annualPayroll: 880000 },
      },
    ],
    policies: [
      {
        line: "Business owners",
        carrier: "lakeshore",
        premium: 4860,
        commission: 15,
        expires: 38,
        priorPremium: 4410,
      },
      {
        line: "Workers compensation",
        carrier: "comp",
        premium: 6240,
        commission: 8,
        expires: 38,
      },
      {
        line: "NY disability & paid family leave",
        carrier: "comp",
        premium: 380,
        commission: 10,
        expires: 38,
      },
      {
        line: "Professional liability",
        carrier: "riverbend",
        premium: 3980,
        commission: 12,
        expires: 38,
      },
      {
        line: "Cyber",
        carrier: "summit",
        premium: 2150,
        commission: 15,
        expires: 38,
      },
    ],
    renewal: {
      stage: "proposal",
      nextAction:
        "Present renewal proposal; BOP up 10% on new building valuation",
      followUp: 1,
    },
  },
  {
    key: "midwest-freight",
    name: "Hudson Freight Partners",
    legalName: "Hudson Freight Partners Inc.",
    type: "business",
    industry: "Regional trucking (NY/NJ/CT)",
    city: "Elmsford",
    street: "450 Saw Mill River Rd",
    postalCode: "10523",
    phone: "555-0162",
    email: "safety@hudsonfreight.example.test",
    producer: "admin",
    service: "manager",
    tags: ["Transportation", "Key account", "Loss sensitive"],
    notes:
      "Two at-fault accidents in the past 18 months. Incumbent indicated +22% on auto.",
    contacts: [
      { name: "Dale Hoffman", title: "President" },
      { name: "Angie Kowalski", title: "Safety & compliance" },
      { name: "Marcus Webb", title: "Controller" },
    ],
    exposures: [
      {
        kind: "vehicle",
        name: "Power units (tractors)",
        values: { count: 14, radius: "500 miles" },
      },
      { kind: "vehicle", name: "Trailers", values: { count: 22 } },
      {
        kind: "payroll",
        name: "Drivers",
        values: { employees: 18, annualPayroll: 1260000 },
      },
      {
        kind: "location",
        name: "Terminal and shop",
        values: { squareFeet: 18000, construction: "Metal" },
      },
    ],
    policies: [
      {
        line: "Commercial auto",
        carrier: "northwoods",
        premium: 118400,
        commission: 10,
        expires: 24,
        priorPremium: 97100,
      },
      {
        line: "General liability",
        carrier: "northwoods",
        premium: 6200,
        commission: 12,
        expires: 24,
      },
      {
        line: "Workers compensation",
        carrier: "comp",
        premium: 41800,
        commission: 6,
        expires: 24,
      },
      {
        line: "NY disability & paid family leave",
        carrier: "comp",
        premium: 2090,
        commission: 10,
        expires: 24,
      },
      {
        line: "Commercial umbrella",
        carrier: "summit",
        premium: 24600,
        commission: 10,
        expires: 24,
      },
      {
        line: "Inland marine",
        carrier: "northwoods",
        premium: 3400,
        commission: 15,
        expires: 24,
      },
    ],
    renewal: {
      stage: "marketing",
      nextAction: "Chase two outstanding auto quotes; incumbent at +22%",
      waitingOn: "Riverbend and Finger Lakes auto quotes",
      followUp: -2,
      notes:
        "Submitted to 3 markets on loss runs and MVRs. Owner wants options before the 15th.",
    },
  },
  {
    key: "sunrise-bakery",
    name: "Sunrise Bakery & Café",
    legalName: "Sunrise Bakery LLC",
    type: "business",
    industry: "Bakery / restaurant",
    city: "Tarrytown",
    street: "38 Main St",
    postalCode: "10591",
    phone: "555-0163",
    email: "hello@sunrisebakery.example.test",
    producer: "admin",
    service: "manager",
    tags: ["Restaurant"],
    contacts: [{ name: "Elena Vasquez", title: "Owner" }],
    exposures: [
      {
        kind: "location",
        name: "Café and kitchen",
        values: { squareFeet: 2400, seats: 38, construction: "Frame" },
      },
    ],
    policies: [
      {
        line: "Business owners",
        carrier: "prairie",
        premium: 5420,
        commission: 15,
        expires: 72,
      },
      {
        line: "Workers compensation",
        carrier: "comp",
        premium: 3860,
        commission: 8,
        expires: 72,
      },
      {
        line: "NY disability & paid family leave",
        carrier: "comp",
        premium: 380,
        commission: 10,
        expires: 72,
      },
      {
        line: "Liquor liability",
        carrier: "summit",
        premium: 1240,
        commission: 15,
        expires: 72,
      },
    ],
    renewal: {
      stage: "collecting",
      nextAction: "Get updated sales figures and liquor receipts from Elena",
      waitingOn: "Client: 2026 sales and liquor receipts",
      followUp: 3,
    },
  },
  {
    key: "ridgeline-roofing",
    name: "Ridgeline Roofing",
    legalName: "Ridgeline Roofing & Exteriors LLC",
    type: "business",
    industry: "Roofing contractor",
    city: "Yonkers",
    street: "1125 Nepperhan Ave",
    postalCode: "10703",
    phone: "555-0164",
    email: "office@ridgelineroofing.example.test",
    producer: "admin",
    service: "manager",
    tags: ["Contractor", "E&S"],
    contacts: [
      { name: "Tom Brandt", title: "Owner" },
      { name: "Lisa Brandt", title: "Office / certificates" },
    ],
    exposures: [
      {
        kind: "payroll",
        name: "Roofing crew",
        values: { classCode: "5551", employees: 11, annualPayroll: 640000 },
      },
      {
        kind: "vehicle",
        name: "Pickups and dump trailer",
        values: { count: 5 },
      },
    ],
    policies: [
      {
        line: "General liability",
        carrier: "summit",
        premium: 68400,
        commission: 12,
        expires: 103,
        priorCarrier: "northwoods",
        priorPremium: 54900,
      },
      {
        line: "Workers compensation",
        carrier: "comp",
        premium: 58200,
        commission: 5,
        expires: 103,
      },
      {
        line: "NY disability & paid family leave",
        carrier: "comp",
        premium: 2910,
        commission: 10,
        expires: 103,
      },
      {
        line: "Commercial auto",
        carrier: "riverbend",
        premium: 14900,
        commission: 12,
        expires: 103,
      },
      {
        line: "Inland marine",
        carrier: "riverbend",
        premium: 1850,
        commission: 15,
        expires: 103,
      },
    ],
    renewal: {
      stage: "review",
      nextAction:
        "Order loss runs; remarket GL in E&S (NY Labor Law 240 exposure)",
      followUp: 6,
    },
  },
  {
    key: "oakridge-apartments",
    name: "Oakridge Apartments",
    legalName: "Oakridge Residential Holdings LLC",
    type: "business",
    industry: "Apartment building owner",
    city: "New Rochelle",
    street: "85 Oakridge Pl",
    postalCode: "10801",
    phone: "555-0165",
    email: "manager@oakridgeapts.example.test",
    producer: "admin",
    service: "manager",
    tags: ["Real estate"],
    contacts: [
      { name: "Greg Lindqvist", title: "Managing member" },
      { name: "Shana Price", title: "Property manager" },
    ],
    exposures: [
      {
        kind: "building",
        name: "Building A (24 units)",
        values: {
          units: 24,
          yearBuilt: 1998,
          construction: "Frame",
          sprinklered: false,
        },
      },
      {
        kind: "building",
        name: "Building B (24 units)",
        values: {
          units: 24,
          yearBuilt: 2001,
          construction: "Frame",
          sprinklered: false,
        },
      },
    ],
    policies: [
      {
        line: "Commercial property",
        carrier: "lakeshore",
        premium: 38600,
        commission: 12,
        expires: 151,
      },
      {
        line: "General liability",
        carrier: "lakeshore",
        premium: 7900,
        commission: 12,
        expires: 151,
      },
      {
        line: "Commercial umbrella",
        carrier: "summit",
        premium: 9200,
        commission: 10,
        expires: 151,
      },
    ],
  },
  {
    key: "precision-auto",
    name: "Precision Auto Repair",
    type: "business",
    industry: "Auto repair",
    city: "Port Chester",
    street: "221 Boston Post Rd",
    postalCode: "10573",
    phone: "555-0166",
    email: "shop@precisionauto.example.test",
    producer: "manager",
    service: "manager",
    contacts: [{ name: "Ray Dominguez", title: "Owner" }],
    exposures: [
      {
        kind: "location",
        name: "Six-bay shop",
        values: { squareFeet: 6200, bays: 6 },
      },
    ],
    policies: [
      {
        line: "Business owners",
        carrier: "prairie",
        premium: 6900,
        commission: 15,
        expires: 211,
      },
      {
        line: "Workers compensation",
        carrier: "comp",
        premium: 7400,
        commission: 8,
        expires: 211,
      },
      {
        line: "NY disability & paid family leave",
        carrier: "comp",
        premium: 380,
        commission: 10,
        expires: 211,
      },
    ],
  },
  {
    key: "green-thumb",
    name: "Green Thumb Landscaping",
    legalName: "Green Thumb Landscape Services Inc.",
    type: "business",
    industry: "Landscaping",
    city: "Ossining",
    street: "14 Croton Ave",
    postalCode: "10562",
    phone: "555-0167",
    email: "info@greenthumb.example.test",
    producer: "admin",
    service: "manager",
    tags: ["Contractor"],
    contacts: [{ name: "Nate Olson", title: "Owner" }],
    exposures: [
      {
        kind: "payroll",
        name: "Seasonal crews",
        values: { employees: 16, annualPayroll: 720000 },
      },
      {
        kind: "equipment",
        name: "Mowers, skid steer, trailers",
        values: { value: 165000 },
      },
    ],
    policies: [
      {
        line: "General liability",
        carrier: "northwoods",
        premium: 8800,
        commission: 12,
        expires: 12,
      },
      {
        line: "Commercial auto",
        carrier: "northwoods",
        premium: 16300,
        commission: 12,
        expires: 12,
      },
      {
        line: "Workers compensation",
        carrier: "comp",
        premium: 19600,
        commission: 6,
        expires: 12,
      },
      {
        line: "NY disability & paid family leave",
        carrier: "comp",
        premium: 980,
        commission: 10,
        expires: 12,
      },
      {
        line: "Inland marine",
        carrier: "northwoods",
        premium: 2750,
        commission: 15,
        expires: 12,
      },
    ],
    renewal: {
      stage: "waiting",
      nextAction: "Bind renewal as quoted once signed acknowledgement is back",
      waitingOn: "Client signature on renewal acknowledgement",
      followUp: 0,
    },
  },
  {
    key: "fox-river-hoa",
    name: "Saw Mill Townhome Association",
    type: "business",
    industry: "Homeowners association",
    city: "Hawthorne",
    street: "PO Box 318",
    postalCode: "10532",
    phone: "555-0168",
    email: "board@sawmillhoa.example.test",
    producer: "manager",
    service: "manager",
    tags: ["Real estate", "Nonprofit"],
    contacts: [
      { name: "Patricia Holm", title: "Board president" },
      { name: "Cornerstone Community Mgmt.", title: "Management company" },
    ],
    policies: [
      {
        line: "Commercial property",
        carrier: "lakeshore",
        premium: 22700,
        commission: 12,
        expires: 266,
      },
      {
        line: "General liability",
        carrier: "lakeshore",
        premium: 2900,
        commission: 12,
        expires: 266,
      },
      {
        line: "Directors & officers",
        carrier: "riverbend",
        premium: 1650,
        commission: 15,
        expires: 266,
      },
    ],
  },
  {
    key: "bright-path",
    name: "Bright Path Learning Center",
    type: "business",
    industry: "Child care",
    city: "Mount Kisco",
    street: "160 Main St",
    postalCode: "10549",
    phone: "555-0169",
    email: "director@brightpath.example.test",
    producer: "admin",
    service: "manager",
    contacts: [{ name: "Monique Harris", title: "Director / owner" }],
    exposures: [
      {
        kind: "operations",
        name: "Licensed child care",
        values: { capacity: 72, staff: 15 },
      },
    ],
    policies: [
      {
        line: "Business owners",
        carrier: "riverbend",
        premium: 7300,
        commission: 15,
        expires: 189,
      },
      {
        line: "Workers compensation",
        carrier: "comp",
        premium: 5100,
        commission: 8,
        expires: 189,
      },
      {
        line: "NY disability & paid family leave",
        carrier: "comp",
        premium: 380,
        commission: 10,
        expires: 189,
      },
      {
        line: "Commercial auto",
        carrier: "riverbend",
        premium: 4200,
        commission: 12,
        expires: 189,
      },
    ],
  },
  {
    key: "capitol-cpa",
    name: "Westchester Square CPAs",
    legalName: "Westchester Square Accounting Group, LLP",
    type: "business",
    industry: "Accounting firm",
    city: "White Plains",
    street: "50 Main St, 9th Floor",
    postalCode: "10606",
    phone: "555-0170",
    email: "admin@wsqcpa.example.test",
    producer: "admin",
    service: "manager",
    tags: ["Professional services", "Referral partner"],
    contacts: [
      { name: "Henry Albrecht", title: "Managing partner" },
      { name: "Jill Park", title: "Office manager" },
    ],
    policies: [
      {
        line: "Business owners",
        carrier: "prairie",
        premium: 2380,
        commission: 15,
        expires: 58,
      },
      {
        line: "Professional liability",
        carrier: "riverbend",
        premium: 11200,
        commission: 12,
        expires: 58,
      },
      {
        line: "Cyber",
        carrier: "summit",
        premium: 3400,
        commission: 15,
        expires: 58,
      },
      {
        line: "Workers compensation",
        carrier: "comp",
        premium: 1900,
        commission: 8,
        expires: 58,
      },
      {
        line: "NY disability & paid family leave",
        carrier: "comp",
        premium: 380,
        commission: 10,
        expires: 58,
      },
    ],
    renewal: {
      stage: "collecting",
      nextAction: "Send professional liability and cyber renewal applications",
      waitingOn: "Client: signed applications",
      followUp: -1,
    },
  },
  {
    key: "northside-brewing",
    name: "Northside Brewing Co.",
    type: "business",
    industry: "Brewery / taproom",
    city: "Beacon",
    street: "422 Main St",
    postalCode: "12508",
    phone: "555-0171",
    email: "brewers@northside.example.test",
    producer: "admin",
    service: "manager",
    status: "prospect",
    source: "Website form",
    tags: ["Restaurant", "New business"],
    notes:
      "Current coverage with a direct writer, renews in about 60 days. Wants liquor and product recall options.",
    contacts: [{ name: "Owen McCarthy", title: "Co-founder" }],
    policies: [],
  },
  {
    key: "kessler-electric",
    name: "Kessler Electric",
    type: "business",
    industry: "Electrical contractor",
    city: "Peekskill",
    street: "9 Lower South St",
    postalCode: "10566",
    phone: "555-0172",
    email: "jobs@kesslerelectric.example.test",
    producer: "manager",
    service: "manager",
    status: "prospect",
    source: "Referral (Harbor & Pine)",
    tags: ["Contractor", "New business"],
    contacts: [{ name: "Brian Kessler", title: "Owner" }],
    policies: [],
  },
  {
    key: "stonebridge-vet",
    name: "Stonebridge Veterinary Clinic",
    type: "business",
    industry: "Veterinary clinic",
    city: "Pleasantville",
    street: "301 Bedford Rd",
    postalCode: "10570",
    phone: "555-0173",
    email: "frontdesk@stonebridgevet.example.test",
    producer: "admin",
    service: "manager",
    contacts: [{ name: "Dr. Alan Fisk", title: "Owner, DVM" }],
    policies: [
      {
        line: "Business owners",
        carrier: "lakeshore",
        premium: 5600,
        commission: 15,
        expires: 322,
      },
      {
        line: "Professional liability",
        carrier: "riverbend",
        premium: 1450,
        commission: 12,
        expires: 322,
      },
      {
        line: "Workers compensation",
        carrier: "comp",
        premium: 4300,
        commission: 8,
        expires: 322,
      },
      {
        line: "NY disability & paid family leave",
        carrier: "comp",
        premium: 380,
        commission: 10,
        expires: 322,
      },
    ],
  },
  {
    key: "true-north-it",
    name: "True North IT Services",
    type: "business",
    industry: "Managed IT services",
    city: "Rye Brook",
    street: "800 Westchester Ave",
    postalCode: "10573",
    phone: "555-0174",
    email: "ops@truenorthit.example.test",
    producer: "manager",
    service: "manager",
    contacts: [{ name: "Fatima Noor", title: "CEO" }],
    policies: [
      {
        line: "Professional liability",
        carrier: "summit",
        premium: 6800,
        commission: 12,
        expires: 87,
      },
      {
        line: "Cyber",
        carrier: "summit",
        premium: 5200,
        commission: 15,
        expires: 87,
      },
      {
        line: "Business owners",
        carrier: "prairie",
        premium: 1580,
        commission: 15,
        expires: 87,
      },
    ],
    renewal: {
      stage: "review",
      nextAction: "Confirm revenue and client count for E&O/cyber renewal",
      followUp: 8,
    },
  },
  {
    key: "maple-street-salon",
    name: "Maple Street Salon",
    type: "business",
    industry: "Salon",
    city: "Larchmont",
    street: "2085 Palmer Ave",
    postalCode: "10538",
    phone: "555-0175",
    email: "book@maplesalon.example.test",
    producer: "manager",
    service: "member",
    contacts: [{ name: "Tasha Greene", title: "Owner" }],
    policies: [
      {
        line: "Business owners",
        carrier: "prairie",
        premium: 1980,
        commission: 15,
        expires: 233,
      },
    ],
  },
  {
    key: "badger-storage",
    name: "Tappan Self Storage",
    type: "business",
    industry: "Self storage",
    city: "Brewster",
    street: "1540 Route 22",
    postalCode: "10509",
    phone: "555-0176",
    email: "manager@tappanstorage.example.test",
    producer: "admin",
    service: "manager",
    contacts: [{ name: "Curt Jansen", title: "Owner" }],
    policies: [
      {
        line: "Commercial property",
        carrier: "badger",
        premium: 14200,
        commission: 12,
        expires: 297,
      },
      {
        line: "General liability",
        carrier: "badger",
        premium: 2100,
        commission: 12,
        expires: 297,
      },
    ],
  },
  // ------------------------------------------------------------ Personal lines
  household(
    "thompson",
    "Mark & Julie Thompson",
    "Larchmont",
    "17 Beach Ave",
    "10538",
    "member",
    [
      {
        line: "Homeowners",
        carrier: "lakeshore",
        premium: 2940,
        commission: 15,
        expires: 17,
        priorPremium: 2510,
      },
      {
        line: "Personal auto",
        carrier: "lakeshore",
        premium: 3260,
        commission: 15,
        expires: 17,
      },
      {
        line: "Personal umbrella",
        carrier: "lakeshore",
        premium: 410,
        commission: 15,
        expires: 17,
      },
    ],
    {
      tags: ["Package", "Remarket"],
      notes:
        "Home up 17% at renewal after the roof claim. Clients asked us to shop it.",
      renewal: {
        stage: "marketing",
        nextAction:
          "Compare Finger Lakes and Taconic Mutual package quotes; call Julie",
        followUp: 0,
      },
      vehicles: [
        "2023 Honda Pilot",
        "2019 Subaru Outback",
        "2008 Toyota Camry (teen driver)",
      ],
    },
  ),
  household(
    "nguyen",
    "Linh & David Nguyen",
    "Eastchester",
    "42 Mill Rd",
    "10709",
    "member",
    [
      {
        line: "Homeowners",
        carrier: "prairie",
        premium: 2380,
        commission: 15,
        expires: 44,
      },
      {
        line: "Personal auto",
        carrier: "prairie",
        premium: 2810,
        commission: 15,
        expires: 44,
      },
    ],
    {
      renewal: {
        stage: "review",
        nextAction: "Offer umbrella; review auto with new driver",
        followUp: 4,
      },
      vehicles: ["2022 Toyota RAV4", "2020 Ford F-150"],
    },
  ),
  household(
    "garcia",
    "Maria Garcia",
    "Yonkers",
    "318 Bronxville Rd",
    "10708",
    "member",
    [
      {
        line: "Homeowners",
        carrier: "badger",
        premium: 1890,
        commission: 15,
        expires: 9,
      },
      {
        line: "Personal auto",
        carrier: "badger",
        premium: 1640,
        commission: 15,
        expires: 9,
      },
    ],
    {
      renewal: {
        stage: "waiting",
        nextAction: "Confirm renewal premium with Maria and update autopay",
        waitingOn: "Client callback",
        followUp: -1,
      },
      vehicles: ["2021 Mazda CX-5"],
    },
  ),
  household(
    "olsen",
    "Erik & Kari Olsen",
    "Chappaqua",
    "9 Hardscrabble Rd",
    "10514",
    "member",
    [
      {
        line: "Homeowners",
        carrier: "lakeshore",
        premium: 3720,
        commission: 15,
        expires: 128,
      },
      {
        line: "Personal auto",
        carrier: "lakeshore",
        premium: 4180,
        commission: 15,
        expires: 128,
      },
      {
        line: "Personal umbrella",
        carrier: "lakeshore",
        premium: 520,
        commission: 15,
        expires: 128,
      },
      {
        line: "Boat",
        carrier: "riverbend",
        premium: 690,
        commission: 15,
        expires: 196,
      },
    ],
    {
      tags: ["Package", "Key account"],
      vehicles: [
        "2024 Chevrolet Tahoe",
        "2022 Tesla Model Y",
        "2018 Jeep Wrangler",
      ],
    },
  ),
  household(
    "patel",
    "Raj & Anita Patel",
    "Scarsdale",
    "24 Brite Ave",
    "10583",
    "admin",
    [
      {
        line: "Homeowners",
        carrier: "prairie",
        premium: 4450,
        commission: 15,
        expires: 82,
      },
      {
        line: "Personal auto",
        carrier: "prairie",
        premium: 3390,
        commission: 15,
        expires: 82,
      },
      {
        line: "Personal umbrella",
        carrier: "prairie",
        premium: 640,
        commission: 15,
        expires: 82,
      },
      {
        line: "Dwelling fire",
        carrier: "badger",
        premium: 1720,
        commission: 15,
        expires: 140,
      },
    ],
    {
      tags: ["Package", "Landlord"],
      notes: "Owns a two-family rental in New Rochelle.",
      renewal: {
        stage: "review",
        nextAction: "Annual review meeting; ask about second rental",
        followUp: 10,
      },
      vehicles: ["2023 Lexus RX", "2021 Honda Accord"],
    },
  ),
  household(
    "schmidt",
    "Karl Schmidt",
    "White Plains",
    "1 Martine Ave, Apt 1104",
    "10606",
    "member",
    [
      {
        line: "Personal auto",
        carrier: "northwoods",
        premium: 1480,
        commission: 12,
        expires: 63,
      },
      {
        line: "Condo",
        carrier: "northwoods",
        premium: 620,
        commission: 15,
        expires: 63,
      },
    ],
    {
      renewal: {
        stage: "review",
        nextAction: "Send renewal summary by email",
        followUp: 12,
      },
      vehicles: ["2017 Buick Encore"],
    },
  ),
  household(
    "johnson",
    "Tyrone & Kim Johnson",
    "Mount Vernon",
    "211 Primrose Ave",
    "10552",
    "member",
    [
      {
        line: "Homeowners",
        carrier: "badger",
        premium: 2160,
        commission: 15,
        expires: 176,
      },
      {
        line: "Personal auto",
        carrier: "badger",
        premium: 2590,
        commission: 15,
        expires: 176,
      },
    ],
    { vehicles: ["2020 Kia Telluride", "2016 Honda Civic"] },
  ),
  household(
    "larson",
    "Ben Larson",
    "Brooklyn",
    "412 Union St, Apt 3R",
    "11231",
    "member",
    [
      {
        line: "Renters",
        carrier: "lakeshore",
        premium: 186,
        commission: 15,
        expires: 31,
      },
      {
        line: "Personal auto",
        carrier: "lakeshore",
        premium: 1720,
        commission: 15,
        expires: 31,
      },
    ],
    {
      renewal: {
        stage: "review",
        nextAction: "Offer to quote home; Ben is closing on a house in March",
        followUp: 5,
      },
      vehicles: ["2019 Volkswagen Jetta"],
    },
  ),
  household(
    "weber",
    "Hans & Greta Weber",
    "Mamaroneck",
    "610 Shore Acres Dr",
    "10543",
    "member",
    [
      {
        line: "Homeowners",
        carrier: "lakeshore",
        premium: 3080,
        commission: 15,
        expires: 247,
      },
      {
        line: "Flood",
        carrier: "riverbend",
        premium: 1140,
        commission: 15,
        expires: 247,
      },
      {
        line: "Personal auto",
        carrier: "lakeshore",
        premium: 2010,
        commission: 15,
        expires: 247,
      },
    ],
    { tags: ["Waterfront"], vehicles: ["2021 Subaru Forester"] },
  ),
  household(
    "kim",
    "Grace Kim",
    "Long Island City",
    "27-28 Thomson Ave, Apt 1802",
    "11101",
    "member",
    [
      {
        line: "Condo",
        carrier: "prairie",
        premium: 710,
        commission: 15,
        expires: 204,
      },
      {
        line: "Personal auto",
        carrier: "prairie",
        premium: 1390,
        commission: 15,
        expires: 204,
      },
    ],
    { vehicles: ["2024 Hyundai Ioniq 5"] },
  ),
  household(
    "brooks",
    "Daniel & Sarah Brooks",
    "Briarcliff Manor",
    "35 Pine Rd",
    "10510",
    "member",
    [
      {
        line: "Homeowners",
        carrier: "northwoods",
        premium: 2470,
        commission: 15,
        expires: 112,
      },
      {
        line: "Personal auto",
        carrier: "northwoods",
        premium: 3540,
        commission: 12,
        expires: 112,
      },
    ],
    {
      renewal: {
        stage: "review",
        nextAction: "Auto rated up for new teen driver; review discounts",
        followUp: 14,
      },
      vehicles: [
        "2022 Honda Odyssey",
        "2018 Ford Escape",
        "2012 Toyota Corolla",
      ],
    },
  ),
  household(
    "andersen",
    "Peter Andersen",
    "Yorktown Heights",
    "1820 Hanover St",
    "10598",
    "member",
    [
      {
        line: "Homeowners",
        carrier: "badger",
        premium: 1760,
        commission: 15,
        expires: 285,
      },
      {
        line: "Personal auto",
        carrier: "badger",
        premium: 1290,
        commission: 15,
        expires: 285,
      },
    ],
    { vehicles: ["2015 Ford F-150"] },
  ),
  household(
    "rossi",
    "Anthony & Nicole Rossi",
    "Bronxville",
    "8 Sagamore Rd",
    "10708",
    "admin",
    [
      {
        line: "Homeowners",
        carrier: "lakeshore",
        premium: 5980,
        commission: 15,
        expires: 51,
      },
      {
        line: "Personal auto",
        carrier: "lakeshore",
        premium: 4620,
        commission: 15,
        expires: 51,
      },
      {
        line: "Personal umbrella",
        carrier: "lakeshore",
        premium: 780,
        commission: 15,
        expires: 51,
      },
    ],
    {
      tags: ["Package", "High value"],
      renewal: {
        stage: "collecting",
        nextAction: "Get jewelry appraisal for scheduled property",
        waitingOn: "Client: appraisal",
        followUp: 2,
      },
      vehicles: ["2025 BMW X5", "2023 Audi Q5"],
    },
  ),
  household(
    "miller",
    "Jessica Miller",
    "Astoria",
    "31-14 Ditmars Blvd, Apt 4B",
    "11105",
    "member",
    [
      {
        line: "Personal auto",
        carrier: "riverbend",
        premium: 2240,
        commission: 12,
        expires: 158,
      },
      {
        line: "Renters",
        carrier: "riverbend",
        premium: 210,
        commission: 15,
        expires: 158,
      },
    ],
    { vehicles: ["2020 Nissan Rogue"] },
  ),
  household(
    "hansen",
    "Steve & Laura Hansen",
    "Cold Spring",
    "62 Fair St",
    "10516",
    "member",
    [
      {
        line: "Homeowners",
        carrier: "prairie",
        premium: 2630,
        commission: 15,
        expires: 342,
      },
      {
        line: "Personal auto",
        carrier: "prairie",
        premium: 3020,
        commission: 15,
        expires: 342,
      },
      {
        line: "Boat",
        carrier: "riverbend",
        premium: 540,
        commission: 15,
        expires: 342,
      },
    ],
    { vehicles: ["2021 GMC Sierra", "2019 Honda CR-V"] },
  ),
  household(
    "baker",
    "Chris Baker",
    "Hastings-on-Hudson",
    "114 Warburton Ave",
    "10706",
    "member",
    [
      {
        line: "Homeowners",
        carrier: "badger",
        premium: 1940,
        commission: 15,
        expires: 220,
      },
    ],
    {
      tags: ["Cross-sell: auto"],
      notes:
        "Auto is with a direct writer. Quote at their renewal in the spring.",
      vehicles: [],
    },
  ),
  household(
    "wright",
    "Ellen Wright",
    "Dobbs Ferry",
    "19 Cedar St",
    "10522",
    "member",
    [
      {
        line: "Homeowners",
        carrier: "lakeshore",
        premium: 2280,
        commission: 15,
        expires: 95,
      },
      {
        line: "Personal auto",
        carrier: "lakeshore",
        premium: 980,
        commission: 15,
        expires: 95,
      },
    ],
    {
      renewal: {
        stage: "review",
        nextAction: "Review senior driver discount and roof age",
        followUp: 9,
      },
      vehicles: ["2014 Toyota Avalon"],
    },
  ),
  household(
    "ali",
    "Omar & Leila Ali",
    "Hartsdale",
    "77 Old Farm Rd",
    "10530",
    "member",
    [
      {
        line: "Homeowners",
        carrier: "northwoods",
        premium: 2720,
        commission: 15,
        expires: 309,
      },
      {
        line: "Personal auto",
        carrier: "northwoods",
        premium: 2950,
        commission: 12,
        expires: 309,
      },
    ],
    { vehicles: ["2023 Toyota Highlander", "2020 Honda Civic"] },
  ),
  household(
    "murphy",
    "Sean Murphy",
    "Pelham",
    "325 Wolfs Ln",
    "10803",
    "member",
    [],
    {
      status: "prospect",
      source: "Referral (Olsen)",
      tags: ["New business"],
      notes:
        "Quote home and auto; currently with a captive agent. Renews in early January.",
      vehicles: [],
    },
  ),
];

function household(
  key: string,
  name: string,
  city: string,
  street: string,
  postalCode: string,
  producer: DemoOwner,
  policies: DemoPolicy[],
  extra: Partial<DemoAccount> & { vehicles: string[] },
): DemoAccount {
  const { vehicles, ...rest } = extra;
  const surname = name.split(" ").at(-1)!.toLowerCase();
  const first = name.split(" ")[0];
  const second = name.includes("&")
    ? name.split("&")[1].trim().split(" ")[0]
    : null;
  return {
    key,
    name,
    type: "person",
    city,
    street,
    postalCode,
    phone: `555-01${(80 + (householdIndex++ % 20)).toString().padStart(2, "0")}`,
    email: `${first.toLowerCase()}.${surname}@mail.example.test`,
    producer,
    service: "member",
    contacts: [
      { name: `${first} ${name.split(" ").at(-1)}`, title: "Named insured" },
      ...(second
        ? [{ name: `${second} ${name.split(" ").at(-1)}`, title: "Spouse" }]
        : []),
    ],
    exposures: [
      ...(policies.some((p) =>
        ["Homeowners", "Condo", "Renters"].includes(p.line),
      )
        ? [
            {
              kind: "location" as const,
              name: "Residence",
              values: { address: `${street}, ${city}, NY` },
            },
          ]
        : []),
      ...vehicles.map((vehicle) => ({
        kind: "vehicle" as const,
        name: vehicle,
        values: { use: "Pleasure / commute" },
      })),
    ],
    policies,
    ...rest,
  };
}

/** Open work across the team, as on an ordinary weekday. Days are offsets from today. */
export const DEMO_WORK: {
  tasks: {
    account: string;
    line?: string;
    title: string;
    description: string;
    owner: DemoOwner;
    due: number;
    priority?: "low" | "normal" | "high" | "urgent";
    status?: "open" | "waiting";
  }[];
  services: {
    account: string;
    line?: string;
    type:
      | "endorsement"
      | "cancellation"
      | "certificate"
      | "billing"
      | "document"
      | "general";
    title: string;
    description: string;
    owner: DemoOwner;
    due: number;
    status?: "open" | "in_progress" | "waiting";
  }[];
  claims: {
    account: string;
    line: string;
    lossDaysAgo: number;
    reportedDaysAgo: number;
    description: string;
    claimNumber?: string;
    status: "notice" | "reported" | "open";
    adjuster?: string;
    owner: DemoOwner;
    followUp: number;
    reserve?: number;
    paid?: number;
  }[];
  notes: {
    account: string;
    category: "note" | "call" | "meeting" | "email" | "review";
    daysAgo: number;
    body: string;
  }[];
} = {
  tasks: [
    {
      account: "midwest-freight",
      line: "Commercial auto",
      title: "Call Dale with auto remarketing update",
      description:
        "Incumbent is at +22%. Share where the Riverbend and Finger Lakes quotes stand and confirm he wants options before the 15th.",
      owner: "admin",
      due: -2,
      priority: "urgent",
    },
    {
      account: "thompson",
      line: "Homeowners",
      title: "Present package remarket to the Thompsons",
      description:
        "Compare the incumbent renewal against the two new package quotes and call Julie.",
      owner: "member",
      due: 0,
      priority: "high",
    },
    {
      account: "lakeview-dental",
      title: "Send renewal proposal to Dr. Raman",
      description:
        "Proposal is drafted. Explain the BOP increase (new building valuation) and the cyber limit option.",
      owner: "admin",
      due: 1,
      priority: "high",
    },
    {
      account: "capitol-cpa",
      title: "Chase signed E&O and cyber applications",
      description:
        "Second reminder. Carrier needs signed applications 30 days before expiration.",
      owner: "manager",
      due: -1,
      priority: "high",
    },
    {
      account: "northside-brewing",
      title: "Quote Northside Brewing (new business)",
      description:
        "Collect current dec pages, 3 years of loss runs, sales and liquor receipts. Markets: Finger Lakes BOP, Summit liquor.",
      owner: "admin",
      due: 3,
    },
    {
      account: "kessler-electric",
      title: "Discovery call with Brian Kessler",
      description:
        "Referral from Harbor & Pine. Ask about payroll, subcontractors, and when GL and WC renew.",
      owner: "manager",
      due: 2,
    },
    {
      account: "murphy",
      title: "Quote home and auto for Sean Murphy",
      description:
        "Referral from the Olsens. Needs declarations from the current carrier.",
      owner: "member",
      due: 4,
    },
    {
      account: "ridgeline-roofing",
      line: "Workers compensation",
      title: "Review WC audit worksheet before submission",
      description:
        "Carrier audit found $85k of uninsured subcontractor payroll. Confirm certificates with Lisa before we dispute.",
      owner: "manager",
      due: -3,
      priority: "high",
      status: "waiting",
    },
    {
      account: "garcia",
      title: "Update Maria's autopay after renewal",
      description: "Taconic Mutual moved her to a new billing account.",
      owner: "member",
      due: 0,
    },
    {
      account: "baker",
      title: "Cross-sell: quote Chris Baker's auto",
      description:
        "Auto is with a direct writer; renews in the spring. Set a reminder 45 days out.",
      owner: "member",
      due: 21,
      priority: "low",
    },
    {
      account: "olsen",
      title: "Annual review with the Olsens",
      description:
        "Discuss umbrella limit (net worth went up) and the new boat.",
      owner: "admin",
      due: 9,
    },
    {
      account: "oakridge-apartments",
      title: "Request updated rent roll and building valuations",
      description:
        "Get it early: property is the largest premium in the book and renews in five months.",
      owner: "manager",
      due: 12,
      priority: "low",
    },
  ],
  services: [
    {
      account: "ridgeline-roofing",
      line: "General liability",
      type: "certificate",
      title:
        "Certificate for Ridge Hill retail reroof (additional insured, waiver)",
      description:
        "Holder: Ridge Hill Retail LLC. Contract requires AI primary/non-contributory and waiver of subrogation.",
      owner: "manager",
      due: 0,
      status: "in_progress",
    },
    {
      account: "green-thumb",
      line: "General liability",
      type: "certificate",
      title: "Certificate for Village of Ossining snow removal contract",
      description: "Holder: Village of Ossining. AI on GL and auto.",
      owner: "member",
      due: 1,
    },
    {
      account: "midwest-freight",
      line: "Commercial auto",
      type: "endorsement",
      title: "Add 2025 Freightliner Cascadia (unit 15)",
      description:
        "VIN on the bill of sale in the filed email. Effective on delivery date.",
      owner: "manager",
      due: 0,
      status: "in_progress",
    },
    {
      account: "brooks",
      line: "Personal auto",
      type: "endorsement",
      title: "Add teen driver: Emma Brooks",
      description:
        "Licensed last week. Ask about good student and driver training discounts.",
      owner: "member",
      due: 2,
    },
    {
      account: "nguyen",
      line: "Homeowners",
      type: "endorsement",
      title: "Mortgagee change after refinance",
      description:
        "New lender: Example Home Lending ISAOA/ATIMA. Send evidence of insurance to the lender.",
      owner: "member",
      due: -1,
    },
    {
      account: "kim",
      line: "Personal auto",
      type: "endorsement",
      title: "Replace vehicle: 2024 Hyundai Ioniq 5",
      description: "Trading in the 2019 Civic. Confirm lienholder.",
      owner: "member",
      due: 1,
      status: "waiting",
    },
    {
      account: "miller",
      line: "Personal auto",
      type: "cancellation",
      title: "Notice of cancellation for non-payment",
      description:
        "Riverbend notice received; cancels in 10 days unless paid. Call Jessica today.",
      owner: "member",
      due: 0,
    },
    {
      account: "sunrise-bakery",
      line: "Business owners",
      type: "billing",
      title: "Premium finance agreement for renewal",
      description: "Elena wants to finance the renewal down payment.",
      owner: "accountant",
      due: 5,
    },
    {
      account: "bright-path",
      line: "Business owners",
      type: "document",
      title: "Proof of insurance for state licensing renewal",
      description:
        "Licensing office needs a certificate and the abuse/molestation endorsement.",
      owner: "manager",
      due: 3,
    },
    {
      account: "fox-river-hoa",
      line: "Commercial property",
      type: "certificate",
      title: "Certificates for unit owners' mortgage lenders (3)",
      description: "Batch from Cornerstone Community Management.",
      owner: "member",
      due: 2,
    },
  ],
  claims: [
    {
      account: "thompson",
      line: "Homeowners",
      lossDaysAgo: 210,
      reportedDaysAgo: 209,
      description: "Hail damage to roof and gutters.",
      claimNumber: "LM-HO-26-118402",
      status: "open",
      adjuster: "K. Barrett (Lakeshore Mutual)",
      owner: "member",
      followUp: 5,
      reserve: 18500,
      paid: 14200,
    },
    {
      account: "midwest-freight",
      line: "Commercial auto",
      lossDaysAgo: 19,
      reportedDaysAgo: 18,
      description:
        "Unit 9 rear-ended a passenger vehicle at a stop light on I-287. Minor injury claimed by the other driver.",
      claimNumber: "NWC-CA-26-55219",
      status: "open",
      adjuster: "R. Ellison (Northwoods Casualty)",
      owner: "manager",
      followUp: -1,
      reserve: 42000,
      paid: 6300,
    },
    {
      account: "sunrise-bakery",
      line: "Business owners",
      lossDaysAgo: 4,
      reportedDaysAgo: 3,
      description:
        "Walk-in cooler failed overnight; spoiled inventory and a day of closure.",
      status: "reported",
      owner: "manager",
      followUp: 1,
    },
    {
      account: "larson",
      line: "Personal auto",
      lossDaysAgo: 2,
      reportedDaysAgo: 1,
      description:
        "Backed into a pole in a parking ramp. Rear bumper damage, no injuries.",
      status: "notice",
      owner: "member",
      followUp: 0,
    },
  ],
  notes: [
    {
      account: "midwest-freight",
      category: "call",
      daysAgo: 6,
      body: "Dale wants the umbrella kept at $5M even if auto goes up. Prefers fewer, larger deductibles.",
    },
    {
      account: "midwest-freight",
      category: "meeting",
      daysAgo: 34,
      body: "Pre-renewal meeting at the terminal. Walked through new driver hiring standards and dash cams on all units, both helpful for remarketing.",
    },
    {
      account: "lakeview-dental",
      category: "review",
      daysAgo: 22,
      body: "Annual review with Dr. Raman. Adding a hygienist in Q1; asked about EPLI. Quote EPLI with the renewal.",
    },
    {
      account: "thompson",
      category: "call",
      daysAgo: 12,
      body: "Julie upset about the 17% increase. Explained the roof claim surcharge. Agreed to remarket the package.",
    },
    {
      account: "ridgeline-roofing",
      category: "email",
      daysAgo: 3,
      body: "Lisa sent certificates for 3 of the 5 subcontractors flagged in the audit.",
    },
    {
      account: "capitol-cpa",
      category: "note",
      daysAgo: 1,
      body: "Henry is referring two more firms. Send a thank-you card.",
    },
    {
      account: "olsen",
      category: "call",
      daysAgo: 15,
      body: "Erik bought a pontoon boat. Bound boat policy with Riverbend.",
    },
    {
      account: "garcia",
      category: "call",
      daysAgo: 2,
      body: "Left voicemail about renewal premium and billing change.",
    },
  ],
};
