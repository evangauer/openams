import type { z } from "zod";
import {
  AMS_FORM_CONTACT_FIELDS,
  AMS_FORM_CONTACT_SECTION,
  AmsFormSectionSchema,
  type AmsFormFieldSchema,
  type AmsFormLine,
  type AmsFormSection,
} from "./forms.js";

/*
 * Starting questions for common lines of business. A form built from the catalog is an
 * ordinary form: the agency can reword, remove or add questions afterwards. The questions
 * are general intake questions written for OpenAMS; they are not carrier or ACORD forms.
 */

type FieldInput = z.input<typeof AmsFormFieldSchema>;
type SectionInput = Omit<z.input<typeof AmsFormSectionSchema>, "lines">;
type Extra = { required?: boolean; help?: string };

const field =
  (type: FieldInput["type"]) =>
  (id: string, label: string, extra: Extra = {}): FieldInput => ({
    id,
    label,
    type,
    ...extra,
  });
export const formField = {
  text: field("text"),
  long: field("longtext"),
  email: field("email"),
  phone: field("phone"),
  number: field("number"),
  money: field("currency"),
  percent: field("percent"),
  year: field("year"),
  zip: field("zip"),
  vin: field("vin"),
  ein: field("ein"),
  date: field("date"),
  yes: field("yesno"),
  address: field("address"),
  file: field("file"),
  pick: (id: string, label: string, options: string[], extra: Extra = {}): FieldInput => ({
    id,
    label,
    type: "select",
    options,
    ...extra,
  }),
  many: (id: string, label: string, options: string[], extra: Extra = {}): FieldInput => ({
    id,
    label,
    type: "multiselect",
    options,
    ...extra,
  }),
  /** Ask `question` only when the earlier question `id` was answered `equals`. */
  when: (id: string, equals: string | boolean, question: FieldInput): FieldInput => ({
    ...question,
    showIf: { field: id, equals },
  }),
};
const {
  text,
  long,
  phone,
  number,
  money,
  percent,
  year,
  zip,
  vin,
  ein,
  date,
  yes,
  address,
  file,
  pick,
  many,
  when,
} = formField;

export interface AmsFormCatalogLine {
  id: string;
  label: string;
  family: "personal" | "commercial";
  /** What the form asks about, for the person choosing lines in the builder. */
  summary: string;
  sections: SectionInput[];
}

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL",
  "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE",
  "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD",
  "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];
export const AMS_FORM_US_STATES: readonly string[] = US_STATES;

/** Asked on most lines: what the client has today. */
const currentCoverage = (id: string, noun: string): SectionInput => ({
  id,
  title: "Your current coverage",
  description: `What you have today helps us compare like for like.`,
  fields: [
    yes("insured", `Do you have ${noun} insurance today?`, { required: true }),
    when("insured", true, text("carrier", "Current insurance company")),
    when("insured", true, date("expires", "When does it renew or expire?")),
    when("insured", true, money("premium", "What do you pay per year?")),
    when(
      "insured",
      true,
      file("declarations", "Current declarations page", {
        help: "A photo or PDF of the page that lists your coverages and limits.",
      }),
    ),
    when(
      "insured",
      false,
      long("uninsured_reason", "Tell us about any gap in coverage"),
    ),
  ],
});
const claims = (period = "5 years"): FieldInput[] => [
  yes("claims", `Any claims or losses in the last ${period}?`, { required: true }),
  when(
    "claims",
    true,
    long("claims_detail", "What happened, when, and about how much was paid?", {
      required: true,
    }),
  ),
];

/* Choices and questions that several lines share. */

const ADVISE = "Not sure, please advise";
const HOME_USE = [
  "Primary home",
  "Second or seasonal home",
  "Rented to others",
  "Vacant or being renovated",
];
const HOME_CONSTRUCTION = [
  "Wood frame",
  "Wood frame with brick or stone siding",
  "Solid brick, stone or concrete block",
  "Log",
  "Other or not sure",
];
const FOUNDATIONS = [
  "Slab",
  "Crawl space",
  "Unfinished basement",
  "Finished basement",
  "Piers, posts or pilings",
  "Not sure",
];
const HOME_PROTECTION = [
  "Smoke detectors",
  "Burglar alarm monitored by a company",
  "Fire alarm monitored by a company",
  "Fire sprinklers",
  "Water leak detector or automatic shutoff",
  "Deadbolt locks",
];
const PERSONAL_LIABILITY_LIMITS = ["$100,000", "$300,000", "$500,000", "$1,000,000", ADVISE];

/** How a house is built. Asked for the home and for each rental property. */
const dwellingFields: FieldInput[] = [
  year("year_built", "Year built", { required: true }),
  number("square_feet", "Living area in square feet", {
    help: "Finished, heated space. A close estimate is fine.",
  }),
  pick("stories", "Number of stories", ["1", "1.5", "2", "3 or more"]),
  pick("construction", "What is it built of?", HOME_CONSTRUCTION),
  pick("foundation", "Foundation", FOUNDATIONS),
  pick("roof", "Roof material", [
    "Asphalt shingle",
    "Metal",
    "Tile",
    "Slate",
    "Wood shake",
    "Flat (rubber or tar)",
    "Other or not sure",
  ]),
  year("roof_year", "Year the roof was last replaced"),
  text("updates", "Years of any wiring, plumbing or heating updates", {
    help: "Carriers ask about these on older homes. Rough years are fine, like: wiring 2015, furnace 2020.",
  }),
];
const dogFields: FieldInput[] = [
  yes("dogs", "Do you have any dogs?"),
  when("dogs", true, text("dog_breeds", "What breeds?")),
  when("dogs", true, yes("dog_bite", "Has a dog of yours ever bitten someone?")),
];
const valuablesFields: FieldInput[] = [
  yes(
    "valuables",
    "Do you have jewelry, art, collectibles or other valuables to list separately?",
    {
      help: "Standard policies limit what they pay for these, so they are often listed with their own values.",
    },
  ),
  when(
    "valuables",
    true,
    long("valuables_detail", "What are they, and roughly what are they worth?"),
  ),
];
/** The amounts to choose from, plus asking the agency to recommend one. */
const deductible = (...amounts: string[]): FieldInput =>
  pick("deductible", "Deductible you prefer", [...amounts, ADVISE], {
    help: "The amount you pay toward a claim before insurance pays the rest.",
  });
const personalLiability = pick(
  "liability",
  "Personal liability limit",
  PERSONAL_LIABILITY_LIMITS,
  {
    help: "Covers you when someone is hurt at your home or you damage someone else's property.",
  },
);

const annualPayroll = money("payroll", "Total annual payroll", {
  help: "Gross wages for all employees over the next 12 months. An estimate is fine.",
});
const businessLiabilityLimit = pick(
  "liability_limit",
  "Liability limit you need",
  [
    "$1 million per claim, $2 million per year",
    "$2 million per claim, $4 million per year",
    ADVISE,
  ],
  {
    help: "The most the policy pays for one claim, and for all claims in a policy year. A contract usually says what it requires.",
  },
);
const lossRuns = file("loss_runs", "Loss runs from your insurance company", {
  help: "A claims history report your insurance company sends on request. Carriers usually want the last 3 to 5 years, even with no claims.",
});
/** Whoever is asking for the coverage usually sets its terms. */
const requiredBy = (who: string): FieldInput[] => [
  yes("contract_required", `Is ${who} requiring this coverage?`),
  when(
    "contract_required",
    true,
    long("contract_requirements", "What do they require?", {
      help: "Limits, any special wording and the deadline. Pasting the insurance paragraph from the contract works well.",
    }),
  ),
];
/** How a commercial building is built, protected and valued. */
const buildingFields: FieldInput[] = [
  number("square_feet", "Size in square feet", {
    help: "The space you occupy, or the whole building if you own it.",
  }),
  year("year_built", "Year built", { required: true, help: "A close guess is fine." }),
  pick("construction", "What is the building made of?", [
    "Wood frame",
    "Brick or block walls with a wood roof",
    "All metal",
    "Brick or block walls with a metal or concrete roof",
    "Concrete and protected steel (fire resistive)",
    "Not sure",
  ]),
  number("stories", "Number of stories"),
  many("protection", "Fire and theft protection", [
    "Fire sprinklers throughout",
    "Fire sprinklers in part of the building",
    "Fire alarm monitored by a company",
    "Burglar alarm monitored by a company",
    "Security cameras",
  ]),
  text("updates", "Years the roof, wiring, plumbing and heating were last updated", {
    help: "Carriers ask for buildings more than about 25 years old. Rough years are fine.",
  }),
  money("building_value", "Building value to insure", {
    help: "If you own the building or your lease makes you insure it. Use the cost to rebuild, not the market value.",
  }),
  money("contents_value", "Value of your business property here", {
    help: "Furniture, equipment, inventory and improvements you made to the space, at what it would cost to replace them.",
  }),
];

export const AMS_FORM_CATALOG: AmsFormCatalogLine[] = [
  {
    id: "auto",
    label: "Auto",
    family: "personal",
    summary: "Drivers, vehicles, driving history and current coverage.",
    sections: [
      {
        id: "auto_drivers",
        title: "Drivers",
        description: "Everyone in the household who is licensed, even if they rarely drive.",
        repeat: { noun: "driver", min: 1, max: 8, title: ["name"] },
        exposure: "driver",
        fields: [
          text("name", "Full name", { required: true }),
          date("birth_date", "Date of birth", { required: true }),
          pick("relationship", "Relationship to you", [
            "Myself",
            "Spouse or partner",
            "Child",
            "Parent",
            "Other relative",
            "Not related",
          ]),
          pick("marital_status", "Marital status", [
            "Single",
            "Married",
            "Domestic partner",
            "Divorced",
            "Widowed",
          ]),
          text("license_number", "Driver's license number", {
            help: "Carriers use it to pull your driving record. Leave it blank and we'll ask later.",
          }),
          pick("license_state", "License state", US_STATES),
          number("age_licensed", "Age first licensed"),
          yes("incidents", "Any accidents or tickets in the last 5 years?", {
            required: true,
          }),
          when(
            "incidents",
            true,
            long("incidents_detail", "What happened, and when?", { required: true }),
          ),
        ],
      },
      {
        id: "auto_vehicles",
        title: "Vehicles",
        description: "Every vehicle you want on the policy.",
        repeat: { noun: "vehicle", min: 1, max: 8, title: ["year", "make", "model"] },
        exposure: "vehicle",
        fields: [
          year("year", "Year", { required: true }),
          text("make", "Make", { required: true }),
          text("model", "Model", { required: true }),
          vin("vin", "VIN", {
            help: "17 characters, on your registration or the driver's door jamb.",
          }),
          pick("ownership", "Do you own, finance or lease it?", [
            "Own",
            "Finance",
            "Lease",
          ]),
          pick("use", "How is it mostly used?", [
            "Commuting",
            "Pleasure",
            "Business",
            "Rideshare or delivery",
            "Farm",
          ]),
          number("annual_miles", "About how many miles a year?"),
          zip("garaging_zip", "ZIP code where it is kept overnight"),
          pick("coverage_wanted", "Coverage you want on this vehicle", [
            "Full coverage (liability, comprehensive and collision)",
            "Liability only",
            "Not sure, please advise",
          ]),
        ],
      },
      currentCoverage("auto_current", "auto"),
    ],
  },
  {
    id: "home",
    label: "Homeowners",
    family: "personal",
    summary: "The home, how it is built, safety features, coverage wanted and current policy.",
    sections: [
      {
        id: "home_property",
        title: "Your home",
        description: "The home you want to insure. Close estimates are fine.",
        exposure: "location",
        fields: [
          address("address", "Address of the home", { required: true }),
          pick("use", "How do you use this home?", HOME_USE),
          pick("home_type", "What kind of home is it?", [
            "Single-family house",
            "Townhouse or row house",
            "Duplex or multi-family",
            "Manufactured or mobile home",
            "Other",
          ]),
          ...dwellingFields,
        ],
      },
      {
        id: "home_features",
        title: "Features and safety",
        description: "A few things every insurance company asks about.",
        fields: [
          pick("heating", "Main source of heat", [
            "Gas furnace or boiler",
            "Electric or heat pump",
            "Oil",
            "Propane",
            "Wood or pellet stove",
            "Other or not sure",
          ]),
          yes("wood_stove", "Is there a wood stove, pellet stove or fireplace insert?"),
          yes("pool", "Is there a swimming pool?"),
          when("pool", true, yes("pool_fenced", "Is it fenced, with a gate that locks?")),
          yes("trampoline", "Is there a trampoline?"),
          ...dogFields,
          many("protection", "Which of these does the home have?", HOME_PROTECTION),
          yes("home_business", "Do you run a business or see customers at the home?"),
          yes("rented_out", "Do you ever rent out all or part of the home?", {
            help: "Including short-term rentals and roommates who pay rent.",
          }),
        ],
      },
      {
        id: "home_coverage",
        title: "Coverage you want",
        description: "Your best guess is fine. We'll go over the options with you.",
        fields: [
          yes("buying", "Are you buying this home now?"),
          when("buying", true, date("closing_date", "Closing date")),
          money("rebuild_cost", "About what would it cost to rebuild the home?", {
            help: "Construction cost, not the sale price or market value. Leave it blank and we'll estimate it.",
          }),
          deductible("$500", "$1,000", "$2,500", "$5,000"),
          personalLiability,
          ...valuablesFields,
          many("extras", "Other coverage you'd like us to look at", [
            "Water or sewer backup",
            "Earthquake",
            "Flood",
            "Buried utility lines",
            "Breakdown of appliances and home systems",
            "Identity theft",
          ]),
          ...claims(),
        ],
      },
      currentCoverage("home_current", "homeowners"),
    ],
  },
  {
    id: "renters",
    label: "Renters",
    family: "personal",
    summary: "The rented home, belongings to cover, liability and current coverage.",
    sections: [
      {
        id: "renters_home",
        title: "The place you rent",
        exposure: "location",
        fields: [
          address("address", "Address you rent", {
            required: true,
            help: "Include the apartment or unit number.",
          }),
          pick("home_type", "What kind of place is it?", [
            "Apartment",
            "House",
            "Condo or townhouse",
            "Duplex or multi-family",
            "Room in a shared home",
            "Other",
          ]),
          date("move_in", "When did you move in, or when will you?"),
          yes("roommates", "Do you share it with roommates who aren't family?", {
            help: "Roommates usually need their own policy. We'll walk you through the options.",
          }),
          ...dogFields,
          many("protection", "Which of these does your place have?", HOME_PROTECTION),
          yes("home_business", "Do you run a business from home?"),
        ],
      },
      {
        id: "renters_coverage",
        title: "Coverage you want",
        description:
          "Renters insurance covers your belongings and your liability. The building is your landlord's to insure.",
        fields: [
          money("belongings", "About what would it cost to replace everything you own?", {
            help: "Furniture, clothes, electronics, kitchen items. A rough number is fine.",
          }),
          deductible("$250", "$500", "$1,000"),
          personalLiability,
          ...valuablesFields,
          yes("landlord_requires", "Does your landlord require proof of insurance?"),
          when(
            "landlord_requires",
            true,
            text("landlord_name", "Landlord or property manager name", {
              help: "We can list them on the policy so they are told you're covered.",
            }),
          ),
          ...claims(),
        ],
      },
      currentCoverage("renters_current", "renters"),
    ],
  },
  {
    id: "condo",
    label: "Condo",
    family: "personal",
    summary: "The unit, what the association's policy covers, coverage wanted and current policy.",
    sections: [
      {
        id: "condo_unit",
        title: "Your condo",
        exposure: "location",
        fields: [
          address("address", "Address of the condo", {
            required: true,
            help: "Include the unit number.",
          }),
          pick("use", "How do you use it?", HOME_USE),
          year("year_built", "Year the building was built", { required: true }),
          number("square_feet", "Size of your unit in square feet"),
          pick("building_type", "What kind of building is it?", [
            "Townhouse style",
            "Low-rise (1 to 3 floors)",
            "Mid-rise (4 to 9 floors)",
            "High-rise (10 or more floors)",
          ]),
          number("floor", "Which floor is your unit on?"),
          pick("construction", "What is the building built of?", [
            "Wood frame",
            "Brick, stone or concrete block",
            "Concrete and steel",
            "Not sure",
          ]),
          text("updates", "Years of any wiring, plumbing or heating updates in your unit", {
            help: "Rough years are fine. Skip it if nothing has been updated or you're not sure.",
          }),
          ...dogFields,
          many("protection", "Which of these does your unit have?", HOME_PROTECTION),
        ],
      },
      {
        id: "condo_coverage",
        title: "Coverage you want",
        description:
          "The association's master policy covers the building. Your policy covers what it leaves to you.",
        fields: [
          pick(
            "master_policy",
            "What does the association's policy cover inside your unit?",
            [
              "Nothing inside the unit (bare walls)",
              "Original cabinets, flooring and fixtures",
              "Everything, including upgrades",
              "Not sure",
            ],
            {
              help: "Your association or property manager can tell you. It decides how much coverage you need for the unit itself.",
            },
          ),
          money("unit_amount", "Coverage for the inside of your unit", {
            help: "Cabinets, flooring, fixtures and upgrades the association doesn't cover. Leave it blank and we'll help you choose.",
          }),
          money("belongings", "About what would it cost to replace your belongings?"),
          deductible("$500", "$1,000", "$2,500", "$5,000"),
          personalLiability,
          money("master_deductible", "The association's own deductible, if you know it", {
            help: "After a large claim, an association can bill owners for its deductible. There is coverage for that, and this tells us how much you need.",
          }),
          ...valuablesFields,
          ...claims(),
          file("master_policy_summary", "Association insurance summary or certificate", {
            help: "If you have it. It helps us match your coverage to the association's.",
          }),
        ],
      },
      currentCoverage("condo_current", "condo"),
    ],
  },
  {
    id: "landlord",
    label: "Landlord / rental property",
    family: "personal",
    summary: "Each rental property, how it is rented and built, coverage wanted and current policy.",
    sections: [
      {
        id: "landlord_properties",
        title: "Rental properties",
        description: "Each property you rent out and want covered.",
        repeat: { noun: "property", min: 1, max: 10, title: ["name"] },
        exposure: "location",
        fields: [
          address("address", "Property address", { required: true }),
          text("name", "A name for this property, if you use one", {
            help: "Like Elm Street duplex. Leave it blank and we'll go by the address.",
          }),
          pick("property_type", "What kind of property is it?", [
            "Single-family house",
            "Duplex",
            "Triplex or fourplex",
            "Condo or townhouse unit",
            "Manufactured or mobile home",
            "Building with 5 or more units",
          ]),
          pick("rental_term", "How is it rented?", [
            "Lease of a year or more",
            "Month to month",
            "Short-term or vacation rental",
            "Student housing",
            "Vacant right now",
          ]),
          ...dwellingFields,
        ],
      },
      {
        id: "landlord_coverage",
        title: "Tenants and coverage",
        fields: [
          text("titled_owner", "Name on the deed, if it isn't yours", {
            help: "For example an LLC or a trust. The policy has to match the owner.",
          }),
          pick("management", "Who manages the properties?", ["I do", "A property manager"]),
          yes("tenant_insurance", "Do you require tenants to carry renters insurance?"),
          yes("detectors", "Does every unit have working smoke and carbon monoxide detectors?"),
          yes("pool", "Does any property have a pool, hot tub or trampoline?"),
          yes("furnished", "Do you provide furniture or appliances you want covered?"),
          money("annual_rent", "Total rent you collect per year", {
            help: "We use it to set coverage for lost rent when a covered loss leaves a unit unlivable.",
          }),
          deductible("$500", "$1,000", "$2,500", "$5,000"),
          pick("liability", "Liability limit", PERSONAL_LIABILITY_LIMITS, {
            help: "Covers you when a tenant or visitor is hurt at the property.",
          }),
          ...claims(),
        ],
      },
      currentCoverage("landlord_current", "rental property"),
    ],
  },
  {
    id: "umbrella",
    label: "Personal umbrella",
    family: "personal",
    summary: "Household drivers, vehicles and properties, the policies underneath and the limit wanted.",
    sections: [
      {
        id: "umbrella_household",
        title: "Your household",
        description:
          "An umbrella sits over everything you own and drive, so we need the whole picture.",
        fields: [
          number("drivers", "How many licensed drivers are in the household?", {
            required: true,
          }),
          number("young_drivers", "How many of them are under 25?"),
          yes(
            "incidents",
            "Has any driver had an accident, ticket or DUI in the last 5 years?",
            { required: true },
          ),
          when(
            "incidents",
            true,
            long("incidents_detail", "Who, what happened, and when?", { required: true }),
          ),
          number("vehicles", "How many cars and trucks do you own or lease?", {
            required: true,
          }),
          number("recreational", "How many motorcycles, RVs, ATVs or golf carts?"),
          yes("watercraft", "Do you own any boats or personal watercraft?"),
          when("watercraft", true, text("watercraft_detail", "Length and horsepower of each")),
          number("homes", "How many homes do you own, including second homes?"),
          number("rentals", "How many rental units do you own?"),
          yes("pool", "Is there a pool or trampoline at any property?"),
          yes(
            "business",
            "Does anyone in the household own a business or farm, or serve on a board?",
          ),
        ],
      },
      {
        id: "umbrella_coverage",
        title: "Coverage underneath",
        description:
          "An umbrella pays after your auto and home policies do, so carriers require certain limits on those policies.",
        fields: [
          pick("limit", "How much umbrella coverage do you want?", [
            "$1 million",
            "$2 million",
            "$3 million",
            "$5 million",
            ADVISE,
          ]),
          text("auto_carrier", "Who insures your vehicles?"),
          pick(
            "auto_liability",
            "Liability limit on your auto policy",
            [
              "$100,000 per person / $300,000 per accident",
              "$250,000 per person / $500,000 per accident",
              "$300,000 combined",
              "$500,000 combined",
              "Lower than these",
              "Not sure",
            ],
            { help: "On your auto policy under bodily injury liability." },
          ),
          text("home_carrier", "Who insures your home?"),
          pick("home_liability", "Liability limit on your home or renters policy", [
            "$100,000",
            "$300,000",
            "$500,000",
            "$1,000,000",
            "Not sure",
          ]),
          file("underlying_policies", "Your auto and home policy pages", {
            help: "The pages that list your coverages and limits. The quickest way to give us the numbers above.",
          }),
          ...claims(),
        ],
      },
      currentCoverage("umbrella_current", "umbrella"),
    ],
  },
  {
    id: "flood",
    label: "Flood",
    family: "personal",
    summary: "The building, its flood zone and elevation, coverage wanted and current policy.",
    sections: [
      {
        id: "flood_property",
        title: "The property",
        exposure: "location",
        fields: [
          address("address", "Address of the property", { required: true }),
          pick("building_type", "What kind of building is it?", [
            "Single-family home",
            "Two to four family home",
            "Condo unit",
            "Manufactured or mobile home",
            "Apartment or condo building",
            "Business or other building",
          ]),
          yes("primary_home", "Is this your primary home?", {
            help: "Flood pricing is different for a home you live in most of the year.",
          }),
          year("year_built", "Year built", { required: true }),
          number("square_feet", "Size in square feet"),
          pick("stories", "Number of floors", ["1", "2", "3 or more"]),
          pick("foundation", "Foundation", FOUNDATIONS),
          pick("construction", "What is it built of?", HOME_CONSTRUCTION),
        ],
      },
      {
        id: "flood_details",
        title: "Flood risk and coverage",
        description:
          "Skip anything you don't know. For the claims question, count any flood damage, whether or not insurance paid.",
        fields: [
          pick(
            "flood_zone",
            "Flood zone, if you know it",
            [
              "A or AE (high risk)",
              "V or VE (high risk, coastal)",
              "X, B or C (moderate to low risk)",
              "Not sure",
            ],
            {
              help: "It's on the flood zone determination from your lender, or on your current flood policy.",
            },
          ),
          yes("lender_requires", "Is a lender requiring flood insurance?"),
          yes("buying", "Are you buying this property now?"),
          when("buying", true, date("closing_date", "Closing date")),
          file("elevation_certificate", "Elevation certificate", {
            help: "A surveyor's form showing how high the building sits. If you have one, it can lower the price.",
          }),
          money("building_amount", "Coverage for the building", {
            help: "Usually the cost to rebuild, or what your lender requires. Leave it blank and we'll recommend an amount.",
          }),
          money("contents_amount", "Coverage for your belongings", {
            help: "Flood policies cover belongings separately from the building.",
          }),
          deductible("$1,000", "$2,000", "$5,000", "$10,000"),
          ...claims("10 years"),
        ],
      },
      currentCoverage("flood_current", "flood"),
    ],
  },
  {
    id: "toys",
    label: "Motorcycle, boat & RV",
    family: "personal",
    summary: "Each motorcycle, boat, RV or off-road vehicle, its operators, use and current coverage.",
    sections: [
      {
        id: "toys_units",
        title: "What you want to insure",
        description: "One entry for each motorcycle, boat, RV, trailer or off-road vehicle.",
        repeat: { noun: "vehicle or boat", min: 1, max: 10, title: ["year", "make", "model"] },
        exposure: "equipment",
        fields: [
          pick(
            "kind",
            "What is it?",
            [
              "Motorcycle",
              "Scooter or moped",
              "ATV or side-by-side",
              "Snowmobile",
              "Golf cart",
              "Boat",
              "Personal watercraft",
              "Motorhome",
              "Travel trailer or fifth wheel",
              "Other",
            ],
            { required: true },
          ),
          year("year", "Year", { required: true }),
          text("make", "Make", { required: true }),
          text("model", "Model", { required: true }),
          text("vin", "VIN, hull ID or serial number", {
            help: "On the registration or title. You can leave it for later.",
          }),
          text("engine", "Engine size or horsepower", {
            help: "For example 650 cc or 150 hp.",
          }),
          number("length", "Length in feet", { help: "For boats, motorhomes and trailers." }),
          money("value", "About what is it worth today?", {
            help: "Include custom parts and permanently attached equipment.",
          }),
          pick("ownership", "Do you own, finance or lease it?", ["Own", "Finance", "Lease"]),
          zip("garaging_zip", "ZIP code where it is kept"),
          pick("coverage_wanted", "Coverage you want on it", [
            "Full coverage (liability plus damage and theft)",
            "Liability only",
            ADVISE,
          ]),
        ],
      },
      {
        id: "toys_operators",
        title: "Operators",
        description: "Everyone who rides or drives them.",
        repeat: { noun: "operator", min: 1, max: 6, title: ["name"] },
        exposure: "driver",
        fields: [
          text("name", "Full name", { required: true }),
          date("birth_date", "Date of birth", { required: true }),
          number("years_experience", "Years of experience with this kind of vehicle or boat"),
          yes("safety_course", "Completed a rider or boater safety course?", {
            help: "Many carriers give a discount for it.",
          }),
          yes("incidents", "Any accidents or tickets in the last 5 years?", {
            required: true,
          }),
          when(
            "incidents",
            true,
            long("incidents_detail", "What happened, and when?", { required: true }),
          ),
        ],
      },
      {
        id: "toys_use",
        title: "Use and history",
        fields: [
          yes("business_use", "Are any of them rented out or used for business?"),
          yes("lived_in", "Does anyone live in an RV or boat full time?"),
          yes("stored", "Are any put away for part of the year?", {
            help: "Some carriers charge less for months in storage.",
          }),
          text("boat_waters", "If you have a boat, where do you use it?", {
            help: "Lakes, rivers, coastal or ocean waters.",
          }),
          many("extras", "Extras you're interested in", [
            "Roadside assistance and towing",
            "Custom parts and accessories",
            "Riding gear and personal belongings",
            "Replacement with a new one if it's totaled",
          ]),
          ...claims(),
        ],
      },
      currentCoverage("toys_current", "motorcycle, boat or RV"),
    ],
  },
  {
    id: "general_liability",
    label: "General liability",
    family: "commercial",
    summary: "Services, payroll and subcontractors, where the work happens, limits and current coverage.",
    sections: [
      {
        id: "general_liability_operations",
        title: "Business operations",
        description:
          "General liability is priced on what you do and how much of it. Estimates are fine.",
        exposure: "operations",
        fields: [
          pick("industry", "Which best describes your business?", [
            "Construction or trades",
            "Retail or wholesale",
            "Restaurant or food service",
            "Office or professional services",
            "Manufacturing",
            "Property owner or manager",
            "Personal services (salon, fitness, cleaning)",
            "Other",
          ]),
          long(
            "services",
            "What products or services do you sell, and roughly what share of sales is each?",
            { help: "For example: 60% kitchen remodels, 30% bathrooms, 10% decks." },
          ),
          annualPayroll,
          yes("subcontractors", "Do you hire subcontractors?"),
          when(
            "subcontractors",
            true,
            money("subcontractor_cost", "About how much do you pay subcontractors per year?"),
          ),
          when(
            "subcontractors",
            true,
            yes(
              "subcontractor_certificates",
              "Do you collect proof of insurance from every subcontractor?",
              {
                help: "Usually a certificate of insurance showing they carry their own liability coverage.",
              },
            ),
          ),
          many("work_sites", "Where does the work happen?", [
            "At our own shop, store or office",
            "At customers' homes",
            "At commercial job sites",
            "Online or remote",
          ]),
          text("states", "States where you work", {
            help: "Every state you do work in, not only where you're based.",
          }),
          number("years_experience", "Years of experience in this kind of work", {
            help: "Including time before you started this business.",
          }),
          address("address", "Main business location", {
            help: "Where you work from, if it's different from your mailing address.",
          }),
          pick("premises", "Do you own or rent that space?", [
            "Own",
            "Rent or lease",
            "Work from home",
            "No fixed location",
          ]),
        ],
      },
      {
        id: "general_liability_coverage",
        title: "Coverage you need",
        description:
          "If a contract, landlord or client is asking for specific coverage, tell us what it says.",
        fields: [
          businessLiabilityLimit,
          ...requiredBy("a contract, landlord or client"),
          when(
            "contract_required",
            true,
            file("contract", "The contract or its insurance requirements page"),
          ),
          yes("certificates", "Will you need certificates of insurance?", {
            help: "A one-page proof of coverage we send to whoever asks you for it.",
          }),
          ...claims(),
          lossRuns,
        ],
      },
      currentCoverage("general_liability_current", "general liability"),
    ],
  },
  {
    id: "bop",
    label: "Business owner's policy (BOP)",
    family: "commercial",
    summary: "Locations, buildings and business property values, liability basics and current coverage.",
    sections: [
      {
        id: "bop_locations",
        title: "Locations",
        description:
          "Each place you do business from. A business owner's policy covers your property and your liability together.",
        repeat: { noun: "location", min: 1, max: 10, title: ["name"] },
        exposure: "location",
        fields: [
          address("address", "Address", { required: true }),
          text("name", "A name for this location, if you use one", {
            help: "Like Main Street shop. Leave it blank and we'll go by the address.",
          }),
          pick("interest", "Do you own or rent the space?", [
            "Own the building",
            "Rent or lease",
            "Work from home",
          ]),
          text("occupancy", "What is the space used for?", {
            help: "For example: retail store, office, warehouse, restaurant.",
          }),
          ...buildingFields,
        ],
      },
      {
        id: "bop_coverage",
        title: "Coverage you need",
        fields: [
          annualPayroll,
          businessLiabilityLimit,
          pick(
            "downtime",
            "If a fire closed you down, how long until you could reopen?",
            ["Under 3 months", "3 to 6 months", "6 to 12 months", "More than a year", "Not sure"],
            {
              help: "Helps us set coverage for lost income and bills that keep coming while you're closed.",
            },
          ),
          yes("alcohol", "Do you sell or serve alcohol?"),
          when(
            "alcohol",
            true,
            percent("alcohol_percent", "About what percent of sales is alcohol?"),
          ),
          many("extras", "Other coverage you'd like us to look at", [
            "Equipment breakdown",
            "Employee theft",
            "Spoiled food or stock",
            "Tools and equipment taken to job sites",
            "Employees driving their own or rented vehicles for work",
            "Claims from employees, such as wrongful firing",
            "Cyber liability",
          ]),
          ...requiredBy("a landlord, lender or contract"),
          ...claims(),
          lossRuns,
        ],
      },
      currentCoverage("bop_current", "business"),
    ],
  },
  {
    id: "workers_comp",
    label: "Workers' compensation",
    family: "commercial",
    summary: "Payroll by type of work and state, owners and officers, safety and current coverage.",
    sections: [
      {
        id: "workers_comp_payroll",
        title: "Payroll by type of work",
        description:
          "Workers' compensation is priced on payroll for each kind of work in each state. Add one entry for each.",
        repeat: { noun: "type of work", min: 1, max: 15, title: ["duties", "state"] },
        exposure: "payroll",
        fields: [
          text("duties", "What kind of work is it?", {
            required: true,
            help: "For example: office work, carpentry, delivery driving, outside sales.",
          }),
          pick("state", "State where the work is done", US_STATES, { required: true }),
          number("full_time", "Full-time employees"),
          number("part_time", "Part-time employees"),
          money("payroll", "Estimated annual payroll for this group", {
            required: true,
            help: "Gross wages for the next 12 months. Leave out owners and officers. We ask about them next.",
          }),
          text("class_code", "Class code, if you know it", {
            help: "A four-digit code on your current policy that identifies the type of work.",
          }),
        ],
      },
      {
        id: "workers_comp_owners",
        title: "Owners and officers",
        description:
          "Owners and officers can often choose whether to be covered. The rules depend on your state and how the business is organized, and we'll confirm what applies to you.",
        repeat: { noun: "owner or officer", min: 1, max: 10, title: ["name"] },
        fields: [
          text("name", "Full name", { required: true }),
          text("title", "Title or role", {
            help: "For example: owner, member, partner, president.",
          }),
          percent("ownership", "Percent of the business they own"),
          text("duties", "What do they do day to day?"),
          pick(
            "coverage",
            "Should this policy cover them?",
            ["Cover them", "Leave them out", ADVISE],
            {
              help: "Covered owners get benefits when hurt at work, and their pay counts toward the premium.",
            },
          ),
          money("pay", "Their annual pay", { help: "Used only if they are covered." }),
        ],
      },
      {
        id: "workers_comp_safety",
        title: "Workplace and history",
        fields: [
          yes("subcontractors", "Do you use subcontractors or independent contractors?"),
          when(
            "subcontractors",
            true,
            yes(
              "subcontractor_certificates",
              "Do you collect proof of workers' compensation coverage from them?",
              { help: "Without it, their pay is usually added to your policy." },
            ),
          ),
          yes("driving", "Do employees drive as part of the job?"),
          yes(
            "high_risk_work",
            "Is any work done at heights, underground, or on or near water?",
          ),
          yes("safety_program", "Do you have a written safety program?"),
          number("experience_mod", "Experience modification factor, if you have one", {
            help: "A number like 0.92 or 1.10 on your current policy that reflects your claims history. Smaller businesses often don't have one.",
          }),
          ...claims(),
          lossRuns,
        ],
      },
      currentCoverage("workers_comp_current", "workers' compensation"),
    ],
  },
  {
    id: "commercial_auto",
    label: "Commercial auto",
    family: "commercial",
    summary: "Vehicles, drivers, how the vehicles are used, limits needed and current coverage.",
    sections: [
      {
        id: "commercial_auto_vehicles",
        title: "Vehicles",
        description:
          "Every vehicle the business owns or leases, including trailers. With a long list, add one here and upload the rest as a spreadsheet further down.",
        repeat: { noun: "vehicle", min: 1, max: 25, title: ["year", "make", "model"] },
        exposure: "vehicle",
        fields: [
          year("year", "Year", { required: true }),
          text("make", "Make", { required: true }),
          text("model", "Model", { required: true }),
          vin("vin", "VIN", {
            help: "17 characters, on the registration or the driver's door jamb.",
          }),
          pick("body_type", "What kind of vehicle is it?", [
            "Car or SUV",
            "Pickup",
            "Cargo or passenger van",
            "Box truck",
            "Dump truck",
            "Tractor (semi)",
            "Trailer",
            "Bus",
            "Other",
          ]),
          number("gross_weight", "Gross vehicle weight in pounds", {
            help: "For trucks. It's on the sticker inside the driver's door.",
          }),
          money("value", "About what is it worth today?", {
            help: "Include permanently attached equipment like racks, lifts or refrigeration units.",
          }),
          pick("ownership", "Do you own, finance or lease it?", ["Own", "Finance", "Lease"]),
          pick("use", "What is it mostly used for?", [
            "Service calls and job sites",
            "Delivering your own goods",
            "Hauling goods for others",
            "Carrying passengers",
            "Sales or office travel",
            "Other",
          ]),
          pick("radius", "How far does it usually travel from where it's parked?", [
            "Under 50 miles",
            "50 to 200 miles",
            "Over 200 miles",
          ]),
          zip("garaging_zip", "ZIP code where it is parked overnight"),
          pick("coverage_wanted", "Coverage you want on this vehicle", [
            "Full coverage (liability, comprehensive and collision)",
            "Liability only",
            ADVISE,
          ]),
        ],
      },
      {
        id: "commercial_auto_drivers",
        title: "Drivers",
        description:
          "Everyone who drives a company vehicle, including owners and part-time drivers.",
        repeat: { noun: "driver", min: 1, max: 25, title: ["name"] },
        exposure: "driver",
        fields: [
          text("name", "Full name", { required: true }),
          date("birth_date", "Date of birth"),
          text("license_number", "Driver's license number", {
            help: "Carriers use it to pull the driving record. Leave it blank and we'll ask later.",
          }),
          pick("license_state", "License state", US_STATES),
          pick("license_type", "License type", ["Regular", "Commercial (CDL)"]),
          number("years_experience", "Years driving this kind of vehicle"),
          yes("incidents", "Any accidents or tickets in the last 3 years, as far as you know?"),
          when(
            "incidents",
            true,
            long("incidents_detail", "What happened, and when?", { required: true }),
          ),
        ],
      },
      {
        id: "commercial_auto_use",
        title: "How the vehicles are used",
        fields: [
          file("schedule", "Vehicle and driver lists", {
            help: "Have a long list? Upload a spreadsheet of your vehicles and drivers instead of typing each one.",
          }),
          long("cargo", "What do the vehicles carry?", {
            help: "Tools, materials, goods, passengers. Mention anything hazardous.",
          }),
          yes("interstate", "Do any vehicles cross state lines?"),
          when(
            "interstate",
            true,
            text("dot_number", "USDOT number, if you have one", {
              help: "The number shown on the side of trucks registered for interstate work.",
            }),
          ),
          yes(
            "personal_use",
            "Do employees take company vehicles home or use them personally?",
          ),
          yes(
            "employee_vehicles",
            "Do employees ever drive their own or rented vehicles for work?",
            { help: "If so, we'll look at coverage that protects the business when they do." },
          ),
          pick(
            "liability_limit",
            "Liability limit you need",
            ["$500,000", "$1,000,000", ADVISE],
            {
              help: "One combined limit for injuries and damage your vehicles cause. Contracts often require $1,000,000.",
            },
          ),
          ...claims(),
          lossRuns,
        ],
      },
      currentCoverage("commercial_auto_current", "commercial auto"),
    ],
  },
  {
    id: "commercial_property",
    label: "Commercial property",
    family: "commercial",
    summary: "Each building, how it is built, used and protected, values to insure and current coverage.",
    sections: [
      {
        id: "commercial_property_buildings",
        title: "Buildings",
        description: "One entry for each building you own or each space you rent.",
        repeat: { noun: "building", min: 1, max: 15, title: ["name"] },
        exposure: "building",
        fields: [
          address("address", "Address", { required: true }),
          text("name", "A name for this building, if you use one", {
            help: "Like Main warehouse. Leave it blank and we'll go by the address.",
          }),
          pick("interest", "Do you own or rent it?", [
            "Own and use it",
            "Own and rent it to others",
            "Rent or lease it",
          ]),
          text("occupancy", "What is the building used for?", {
            help: "Your use and any other tenants. For example: our machine shop, with a print shop next door.",
          }),
          ...buildingFields,
        ],
      },
      {
        id: "commercial_property_coverage",
        title: "Coverage you want",
        fields: [
          pick(
            "valuation",
            "How should a loss be paid?",
            ["Replacement cost", "Actual cash value", ADVISE],
            {
              help: "Replacement cost pays to repair or replace with new. Actual cash value subtracts for age and wear, and costs less.",
            },
          ),
          deductible("$1,000", "$2,500", "$5,000", "$10,000", "$25,000"),
          money("business_income", "Income to protect if you had to close", {
            help: "About a year of profit plus bills that keep coming, like rent and payroll. Leave it blank and we'll work it out with you.",
          }),
          many("extras", "Other coverage you'd like us to look at", [
            "Equipment breakdown",
            "Flood",
            "Earthquake",
            "Outdoor signs",
            "Property in transit or at job sites",
            "Spoiled food or stock",
            "Costs to meet current building codes",
          ]),
          yes("vacant", "Is any building vacant or mostly empty?"),
          yes("hazards", "Do you store or use flammable or hazardous materials?"),
          when(
            "hazards",
            true,
            long("hazards_detail", "What are they, and how are they stored?"),
          ),
          ...claims(),
          lossRuns,
          file("statement_of_values", "Property list or recent appraisal", {
            help: "If you have a list of your buildings with their insured values, or a recent appraisal, add it here.",
          }),
        ],
      },
      currentCoverage("commercial_property_current", "commercial property"),
    ],
  },
  {
    id: "professional_liability",
    label: "Professional liability (E&O)",
    family: "commercial",
    summary: "Services and clients, contracts, limits needed, known issues and current coverage.",
    sections: [
      {
        id: "professional_liability_services",
        title: "Your professional services",
        description:
          "Professional liability covers claims that your advice or work cost a client money.",
        fields: [
          pick("profession", "Which best describes your profession?", [
            "Accounting or bookkeeping",
            "Architecture or engineering",
            "Consulting",
            "Financial services",
            "Healthcare or wellness",
            "Insurance",
            "Legal",
            "Marketing or design",
            "Real estate",
            "Technology",
            "Other",
          ]),
          long(
            "services",
            "What services do you provide, and roughly what share of revenue is each?",
            { help: "For example: 70% tax preparation, 30% bookkeeping." },
          ),
          number("professionals", "How many people provide these services?", {
            help: "Count owners, employees and contractors who do client work.",
          }),
          text("licenses", "Professional licenses or certifications"),
          number("years_experience", "Years of experience in this profession"),
          pick("clients", "Who are your clients mostly?", [
            "Individuals",
            "Small businesses",
            "Large companies",
            "Government",
            "A mix",
          ]),
          money("largest_client", "Revenue from your largest client last year", {
            help: "Carriers look at how much of your work depends on one client.",
          }),
          yes(
            "written_contracts",
            "Do you use a written contract or engagement letter with every client?",
          ),
          yes("subcontracts", "Do you pass any of the work to subcontractors?"),
        ],
      },
      {
        id: "professional_liability_coverage",
        title: "Coverage and history",
        fields: [
          pick("limit", "Limit you need", [
            "$250,000",
            "$500,000",
            "$1 million",
            "$2 million",
            ADVISE,
          ]),
          deductible("$1,000", "$2,500", "$5,000", "$10,000"),
          ...requiredBy("a client, contract or licensing board"),
          date("retroactive_date", "Retroactive date, if you have coverage now", {
            help: "The date your current policy reaches back to. It is listed on the policy, and keeping it protects your past work.",
          }),
          yes(
            "known_issues",
            "Do you know of any complaint, dispute or mistake that could turn into a claim?",
          ),
          when(
            "known_issues",
            true,
            long("known_issues_detail", "What happened?", { required: true }),
          ),
          ...claims(),
          lossRuns,
        ],
      },
      currentCoverage("professional_liability_current", "professional liability"),
    ],
  },
  {
    id: "cyber",
    label: "Cyber liability",
    family: "commercial",
    summary: "Data held, card payments, security practices, limit needed and current coverage.",
    sections: [
      {
        id: "cyber_data",
        title: "Your data and systems",
        description:
          "Cyber insurance is priced on the information you hold and how much you rely on your systems.",
        fields: [
          many("data_types", "What kinds of sensitive information do you keep?", [
            "Customer names and contact details",
            "Payment card details",
            "Bank account details",
            "Government ID numbers",
            "Health or medical records",
            "Employee records",
          ]),
          pick(
            "record_count",
            "About how many people's records do you hold?",
            [
              "Fewer than 1,000",
              "1,000 to 10,000",
              "10,000 to 100,000",
              "100,000 to 1 million",
              "More than 1 million",
              "Not sure",
            ],
            {
              help: "Customers, patients, employees: anyone whose personal information you keep.",
            },
          ),
          yes("card_payments", "Do you accept credit or debit cards?"),
          when(
            "card_payments",
            true,
            pick("card_handling", "How are card payments handled?", [
              "A payment processor handles everything",
              "We store card details ourselves",
              "Not sure",
            ]),
          ),
          percent(
            "online_percent",
            "About what percent of revenue comes through your website or app?",
          ),
          pick("it_support", "Who looks after your IT?", [
            "In-house IT staff",
            "An outside IT company",
            "An owner or employee, informally",
            "No one in particular",
          ]),
          pick("downtime", "If your systems were down for a day, how hard would it hit you?", [
            "Barely",
            "Some lost sales or productivity",
            "We couldn't operate",
          ]),
        ],
      },
      {
        id: "cyber_security",
        title: "Security practices",
        description:
          "Carriers ask about these on every cyber application. Check with whoever handles your IT, and skip any you aren't sure of.",
        fields: [
          pick(
            "mfa",
            "Do you require a second sign-in step for email and remote access?",
            ["Yes, for everyone", "For some people or systems", "No", "Not sure"],
            {
              help: "Also called multi-factor authentication: a code or app prompt on top of a password.",
            },
          ),
          pick("backups", "How often do you back up important data?", [
            "Daily",
            "Weekly",
            "Less often",
            "Never",
            "Not sure",
          ]),
          yes("backups_separate", "Is a backup kept offline or apart from your main network?"),
          yes(
            "security_software",
            "Is antivirus or other security software on every computer?",
          ),
          yes("updates", "Are security updates installed within about 30 days?"),
          yes("encryption", "Are laptops and phones that hold business data encrypted?"),
          yes("training", "Do employees get training on spotting scam emails?"),
          yes(
            "payment_checks",
            "Do you confirm new or changed payment details by phone before sending money?",
            {
              help: "A common scam is an email that looks like a vendor asking you to pay a new account.",
            },
          ),
          yes("response_plan", "Do you have a written plan for responding to a breach?"),
        ],
      },
      {
        id: "cyber_coverage",
        title: "Coverage and history",
        description:
          "For the claims question, count any breach, ransomware, payment fraud or outage, whether or not insurance was involved.",
        fields: [
          pick("limit", "Limit you need", [
            "$250,000",
            "$500,000",
            "$1 million",
            "$2 million",
            "$5 million",
            ADVISE,
          ]),
          ...requiredBy("a client or contract"),
          ...claims("3 years"),
        ],
      },
      currentCoverage("cyber_current", "cyber"),
    ],
  },
];

const catalogLine = (id: string) => AMS_FORM_CATALOG.find((line) => line.id === id);

/** The contact section every form opens with, worded for the lines on the form. */
export function amsFormContactSection(lineIds: string[]): AmsFormSection {
  const families = new Set(lineIds.map((id) => catalogLine(id)?.family ?? "personal"));
  const commercialOnly = families.size === 1 && families.has("commercial");
  return AmsFormSectionSchema.parse({
    id: AMS_FORM_CONTACT_SECTION,
    title: commercialOnly ? "About you and your business" : "About you",
    description: "So we know who to get back to.",
    fields: [
      text(AMS_FORM_CONTACT_FIELDS.name, "Your full name", { required: true }),
      ...(families.has("commercial")
        ? [
            text(
              AMS_FORM_CONTACT_FIELDS.business,
              commercialOnly ? "Business name" : "Business name, if this is for a business",
              { required: commercialOnly },
            ),
          ]
        : []),
      formField.email(AMS_FORM_CONTACT_FIELDS.email, "Email", { required: true }),
      phone(AMS_FORM_CONTACT_FIELDS.phone, "Phone", { required: true }),
      pick("contact_method", "Best way to reach you", ["Email", "Phone call", "Text message"]),
      address(AMS_FORM_CONTACT_FIELDS.address, "Mailing address"),
    ],
  });
}

/** Asked once when any commercial line is chosen. */
const businessSection: SectionInput = {
  id: "business",
  title: "Your business",
  description: "The basics every commercial quote starts from.",
  fields: [
    pick("entity", "How is the business organized?", [
      "Sole proprietor",
      "LLC",
      "Corporation",
      "Partnership",
      "Nonprofit",
      "Other",
    ]),
    year("year_started", "Year the business started"),
    long("operations", "What does the business do?", {
      required: true,
      help: "A few sentences: your products or services, and who your customers are.",
    }),
    money("revenue", "Annual revenue, roughly"),
    number("employees", "Number of employees, including owners"),
    text("website", "Website"),
    ein("fein", "Federal tax ID (FEIN)", {
      help: "Carriers ask for it on most commercial policies. You can leave it for later.",
    }),
  ],
};
/** The closing section of every form. */
const wrapUpSection: SectionInput = {
  id: "wrap_up",
  title: "Last details",
  fields: [
    date("effective_date", "When would you like coverage to start?"),
    long("notes", "Anything else we should know?"),
    file("documents", "Other documents", {
      help: "Anything that helps: current policies, loss runs, photos, schedules.",
    }),
  ],
};

export interface AmsFormDraft {
  lines: AmsFormLine[];
  sections: AmsFormSection[];
}
const BUSINESS_SECTION = "business";
const WRAP_UP_SECTION = "wrap_up";
const lineSections = (line: AmsFormCatalogLine) =>
  line.sections.map((input) => AmsFormSectionSchema.parse({ ...input, lines: [line.id] }));
const isCommercial = (id: string) => catalogLine(id)?.family === "commercial";

/** The lines and sections of a new form for the chosen catalog lines, in catalog order. */
export function amsFormFromCatalog(lineIds: string[]): AmsFormDraft {
  const chosen = AMS_FORM_CATALOG.filter((line) => lineIds.includes(line.id));
  const ids = chosen.map((line) => line.id);
  const commercial = ids.filter(isCommercial);
  return {
    lines: chosen.map(({ id, label }) => ({ id, label })),
    sections: [
      amsFormContactSection(ids),
      ...(commercial.length
        ? [AmsFormSectionSchema.parse({ ...businessSection, lines: commercial })]
        : []),
      ...chosen.flatMap(lineSections),
      AmsFormSectionSchema.parse(wrapUpSection),
    ],
  };
}
/** Refresh catalog wording and requirements while retaining agency-written questions. */
function updateContact(form: AmsFormDraft, lines: AmsFormLine[], sections: AmsFormSection[]) {
  const contact = sections[0];
  if (contact?.id !== AMS_FORM_CONTACT_SECTION) return sections;
  const before = amsFormContactSection(form.lines.map((line) => line.id));
  const after = amsFormContactSection(lines.map((line) => line.id));
  const business = AMS_FORM_CONTACT_FIELDS.business;
  const oldField = before.fields.find((field) => field.id === business);
  const newField = after.fields.find((field) => field.id === business);
  const existing = contact.fields.find((field) => field.id === business);
  let fields = contact.fields;
  if (existing && oldField && JSON.stringify(existing) === JSON.stringify(oldField)) {
    fields = fields.flatMap((field) => field.id === business ? (newField ? [newField] : []) : [field]);
  } else if (!existing && !oldField && newField) {
    fields = [fields[0], newField, ...fields.slice(1)];
  }
  const title = contact.title === before.title ? after.title : contact.title;
  return [{ ...contact, title, fields }, ...sections.slice(1)];
}
/**
 * Adds a catalog line to a form the agency may already have edited: its sections go in
 * before the closing section, and nothing already on the form is reworded.
 */
export function amsFormAddLine(form: AmsFormDraft, lineId: string): AmsFormDraft {
  const line = catalogLine(lineId);
  if (!line || form.lines.some((item) => item.id === lineId)) return form;
  const lines = [...form.lines, { id: line.id, label: line.label }];
  const commercial = lines.map((item) => item.id).filter(isCommercial);
  const taken = new Set(form.sections.map((section) => section.id));
  let sections = form.sections.map((section) =>
    section.id === BUSINESS_SECTION ? { ...section, lines: commercial } : section,
  );
  // The shared business questions come right after the contact section, as on a new form.
  if (line.family === "commercial" && !taken.has(BUSINESS_SECTION))
    sections = [
      ...sections.slice(0, 1),
      AmsFormSectionSchema.parse({ ...businessSection, lines: commercial }),
      ...sections.slice(1),
    ];
  const added = lineSections(line).filter((section) => !taken.has(section.id));
  const end = sections.findIndex((section) => section.id === WRAP_UP_SECTION);
  sections =
    end === -1
      ? [...sections, ...added]
      : [...sections.slice(0, end), ...added, ...sections.slice(end)];
  return { lines, sections: updateContact(form, lines, sections) };
}
/** Removes a line and the sections that were asked only for it. */
export function amsFormRemoveLine(form: AmsFormDraft, lineId: string): AmsFormDraft {
  const lines = form.lines.filter((line) => line.id !== lineId);
  const sections = form.sections.flatMap((section) => {
    if (!section.lines.includes(lineId)) return [section];
    const remaining = section.lines.filter((id) => id !== lineId);
    return remaining.length ? [{ ...section, lines: remaining }] : [];
  });
  return { lines, sections: updateContact(form, lines, sections) };
}
