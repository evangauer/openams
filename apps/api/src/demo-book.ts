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
  prairie: "Prairie State Insurance",
  northwoods: "Northwoods Casualty",
  badger: "Badger Valley Mutual",
  summit: "Summit Specialty (E&S)",
  comp: "Great Lakes Comp Fund",
  riverbend: "Riverbend Indemnity",
} as const;
export type DemoCarrier = keyof typeof DEMO_CARRIERS;

type Coverage = { name: string; limit?: string; deductible?: string };

/** Typical coverage lines per line of business, so each policy has believable terms. */
export const DEMO_COVERAGES: Record<string, Coverage[]> = {
  "Personal auto": [
    { name: "Bodily injury liability", limit: "$250,000 / $500,000" },
    { name: "Property damage liability", limit: "$100,000" },
    { name: "Uninsured motorist", limit: "$250,000 / $500,000" },
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
    { name: "Workers compensation", limit: "Statutory (WI)" },
    { name: "Employers liability, each accident", limit: "$500,000" },
    { name: "Employers liability, disease each employee", limit: "$500,000" },
  ],
  "Commercial auto": [
    { name: "Combined single limit", limit: "$1,000,000" },
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
    city: "Middleton",
    street: "2210 Parmenter St, Suite 140",
    postalCode: "53562",
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
    name: "Midwest Freight Partners",
    legalName: "Midwest Freight Partners Inc.",
    type: "business",
    industry: "Regional trucking",
    city: "Sun Prairie",
    street: "4400 Commerce Dr",
    postalCode: "53590",
    phone: "555-0162",
    email: "safety@midwestfreight.example.test",
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
      waitingOn: "Riverbend and Prairie State auto quotes",
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
    city: "Madison",
    street: "318 Atwood Ave",
    postalCode: "53704",
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
    city: "Verona",
    street: "915 Enterprise Way",
    postalCode: "53593",
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
        premium: 21400,
        commission: 12,
        expires: 103,
        priorCarrier: "northwoods",
        priorPremium: 17800,
      },
      {
        line: "Workers compensation",
        carrier: "comp",
        premium: 58200,
        commission: 5,
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
      nextAction: "Order loss runs; plan WC audit review before remarketing",
      followUp: 6,
    },
  },
  {
    key: "oakridge-apartments",
    name: "Oakridge Apartments",
    legalName: "Oakridge Residential Holdings LLC",
    type: "business",
    industry: "Apartment building owner",
    city: "Fitchburg",
    street: "5600 Oakridge Ct",
    postalCode: "53711",
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
    city: "Madison",
    street: "2741 E Washington Ave",
    postalCode: "53704",
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
    ],
  },
  {
    key: "green-thumb",
    name: "Green Thumb Landscaping",
    legalName: "Green Thumb Landscape Services Inc.",
    type: "business",
    industry: "Landscaping",
    city: "Waunakee",
    street: "600 Industrial Dr",
    postalCode: "53597",
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
    name: "Fox River Townhome Association",
    type: "business",
    industry: "Homeowners association",
    city: "Madison",
    street: "PO Box 4410",
    postalCode: "53744",
    phone: "555-0168",
    email: "board@foxriverhoa.example.test",
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
    city: "Sun Prairie",
    street: "1450 Main St",
    postalCode: "53590",
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
    name: "Capitol Square CPAs",
    legalName: "Capitol Square Accounting Group, LLP",
    type: "business",
    industry: "Accounting firm",
    city: "Madison",
    street: "10 E Main St, Floor 6",
    postalCode: "53703",
    phone: "555-0170",
    email: "admin@capitolcpa.example.test",
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
    city: "Madison",
    street: "1202 N Sherman Ave",
    postalCode: "53704",
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
    city: "Stoughton",
    street: "88 Commerce Pkwy",
    postalCode: "53589",
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
    city: "McFarland",
    street: "5120 Farwell St",
    postalCode: "53558",
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
    ],
  },
  {
    key: "true-north-it",
    name: "True North IT Services",
    type: "business",
    industry: "Managed IT services",
    city: "Middleton",
    street: "8401 Greenway Blvd",
    postalCode: "53562",
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
    city: "Monona",
    street: "402 Maple St",
    postalCode: "53716",
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
    name: "Badger Self Storage",
    type: "business",
    industry: "Self storage",
    city: "DeForest",
    street: "6900 Hwy 51",
    postalCode: "53532",
    phone: "555-0176",
    email: "manager@badgerstorage.example.test",
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
    "Madison",
    "4418 Hillcrest Dr",
    "53705",
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
          "Compare Prairie State and Badger Valley package quotes; call Julie",
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
    "Fitchburg",
    "2903 Sandstone Ct",
    "53711",
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
    "Madison",
    "1720 Jenifer St",
    "53704",
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
    "Verona",
    "702 Prairie Oaks Ln",
    "53593",
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
    "Middleton",
    "3109 Bluff Point Rd",
    "53562",
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
      notes: "Owns one rental duplex on Regent St.",
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
    "Sun Prairie",
    "1188 Bird St",
    "53590",
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
    "Madison",
    "5214 Tolman Ter",
    "53711",
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
    "Madison",
    "126 Langdon St, Apt 5",
    "53703",
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
    "Monona",
    "6008 Bridge Rd",
    "53716",
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
    "Madison",
    "15 S Butler St, Unit 902",
    "53703",
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
    "Waunakee",
    "410 Woodland Dr",
    "53597",
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
    "Stoughton",
    "938 Kensington Dr",
    "53589",
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
    "Middleton",
    "7302 Elmwood Ave",
    "53562",
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
    "Fitchburg",
    "2655 Fish Hatchery Rd",
    "53713",
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
    "DeForest",
    "330 Vinburn Rd",
    "53532",
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
    "Madison",
    "814 Spaight St",
    "53703",
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
    "Monona",
    "5901 Winnequah Rd",
    "53716",
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
    "Madison",
    "6626 Old Sauk Rd",
    "53705",
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
    "Sun Prairie",
    "2440 Columbus St",
    "53590",
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
              values: { address: `${street}, ${city}, WI` },
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
