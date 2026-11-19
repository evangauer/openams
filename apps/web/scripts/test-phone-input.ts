import assert from "node:assert/strict";
import { internationalPhone } from "../src/lib/auth-methods";
import {
  PHONE_COUNTRIES,
  caretAfterDigits,
  defaultCountry,
  dialCode,
  examplePlaceholder,
  formatInternational,
  formatNational,
  parseTyped,
  phoneCountries,
  toE164,
} from "../src/lib/phone-input";

// The list: unique regions, digit-only calling codes, the ones the product must offer.
const isos = PHONE_COUNTRIES.map(([iso]) => iso);
assert.equal(new Set(isos).size, isos.length, "every ISO code is listed once");
for (const [iso, dial] of PHONE_COUNTRIES) {
  assert.match(iso, /^[A-Z]{2}$/, iso);
  assert.match(dial, /^[1-9]\d{0,2}$/, `${iso} calling code`);
}
assert.ok(isos.length >= 60 && isos.length <= 100);
const expected: Record<string, string> = {
  US: "1", CA: "1", MX: "52", GB: "44", IE: "353", AU: "61", NZ: "64", IN: "91", PH: "63",
  FR: "33", DE: "49", ES: "34", IT: "39", NL: "31", BR: "55", AR: "54", CO: "57", JP: "81", CN: "86", KR: "82",
};
for (const [iso, dial] of Object.entries(expected)) assert.equal(dialCode(iso), dial, iso);
// No calling code is the start of another, so a typed `+` number has one reading.
const dials = [...new Set(PHONE_COUNTRIES.map(([, dial]) => dial))];
for (const a of dials) for (const b of dials) assert.ok(a === b || !b.startsWith(a), `+${a} and +${b}`);

const picker = phoneCountries("en");
assert.equal(picker.length, isos.length);
assert.deepEqual(picker[0], { iso: "US", dial: "1", name: "United States" });
const names = picker.slice(1).map(({ name }) => name);
assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "en")));
for (const { iso, name } of picker) assert.notEqual(name, iso, `${iso} has a display name`);

assert.equal(defaultCountry("en-US"), "US");
assert.equal(defaultCountry("en-CA"), "CA");
assert.equal(defaultCountry("es-MX"), "MX");
assert.equal(defaultCountry("en"), "US");
assert.equal(defaultCountry("en-AQ"), "US");
assert.equal(defaultCountry("not a locale"), "US");
assert.equal(defaultCountry(undefined), "US");

// Typing a U.S. number one key at a time, then deleting it one key at a time.
const typing = ["", "(2", "(20", "(202", "(202) 5", "(202) 55", "(202) 555", "(202) 555-0", "(202) 555-01", "(202) 555-012", "(202) 555-0123"];
let field = "";
for (const [index, digit] of [..."2025550123"].entries()) {
  field = formatNational("US", parseTyped("US", field + digit).national);
  assert.equal(field, typing[index + 1]);
}
for (let index = typing.length - 2; index >= 0; index -= 1) {
  field = formatNational("US", parseTyped("US", field.slice(0, -1)).national);
  assert.equal(field, typing[index], "one backspace always removes one digit");
}
// Deleting punctuation in the middle changes nothing, and the caret lands before it.
assert.equal(formatNational("US", "(202)555-0123"), "(202) 555-0123");
assert.equal(caretAfterDigits("(202) 555-0123", 3), 4);
assert.equal(caretAfterDigits("(202) 555-0123", 10), 14);
assert.equal(caretAfterDigits("(202) 555-0123", 0), 1);
assert.equal(caretAfterDigits("", 0), 0);
assert.equal(formatNational("CA", "2025550123"), "(202) 555-0123");
assert.equal(formatNational("US", "202.555.0123"), "(202) 555-0123");

// Other countries: plain groups, no national plan.
assert.equal(formatNational("GB", "7700900123"), "770 090 0123");
assert.equal(formatNational("GB", "07700900123"), "077 009 001 23");
assert.equal(formatNational("FR", "1234"), "1234");
assert.equal(formatNational("FR", "12345"), "123 45");
assert.equal(formatNational("FR", ""), "");
assert.equal(examplePlaceholder("US"), "(202) 555-0123");
assert.equal(examplePlaceholder("GB"), "123 456 7890");

// Pasting or autofilling a number with its calling code.
assert.deepEqual(parseTyped("US", "+12025550123"), { iso: "US", national: "2025550123" });
assert.deepEqual(parseTyped("CA", "+1 (202) 555-0123"), { iso: "CA", national: "2025550123" });
assert.deepEqual(parseTyped("GB", "+12025550123"), { iso: "US", national: "2025550123" });
assert.deepEqual(parseTyped("US", "+44 7700 900123"), { iso: "GB", national: "7700900123" });
assert.deepEqual(parseTyped("US", "+353 20 910 1234"), { iso: "IE", national: "209101234" });
assert.deepEqual(parseTyped("US", "+7 000 555 01 23"), { iso: "RU", national: "0005550123" });
assert.deepEqual(parseTyped("KZ", "+7 000 555 01 23"), { iso: "KZ", national: "0005550123" });
assert.deepEqual(parseTyped("US", "+4"), { iso: "US", national: "+4" });
assert.deepEqual(parseTyped("US", "+44"), { iso: "GB", national: "" });
assert.deepEqual(parseTyped("US", "+"), { iso: "US", national: "+" });
// A U.S. number typed or autofilled with its leading 1.
assert.deepEqual(parseTyped("US", "1 202 555 0123"), { iso: "US", national: "2025550123" });
assert.deepEqual(parseTyped("US", "12025550123"), { iso: "US", national: "2025550123" });
assert.deepEqual(parseTyped("US", "1202555012"), { iso: "US", national: "1202555012" });
assert.deepEqual(parseTyped("GB", "12025550123"), { iso: "GB", national: "12025550123" });
assert.deepEqual(parseTyped("US", "(202) 555-0123"), { iso: "US", national: "2025550123" });

// The value sent on: E.164, and accepted by the final validator.
assert.equal(toE164("US", "(202) 555-0123"), "+12025550123");
assert.equal(toE164("GB", "07700 900123"), "+447700900123");
assert.equal(toE164("GB", "7700 900123"), "+447700900123");
assert.equal(toE164("AU", "0491 570 006"), "+61491570006");
assert.equal(toE164("IT", "06 0000 0000"), "+390600000000", "Italy keeps its leading zero");
assert.equal(toE164("GB", "007700900123"), "+4407700900123", "only one trunk zero is dropped");
for (const pasted of ["+12025550123", "+447700900123", "+353209101234"]) {
  const typed = parseTyped("US", pasted);
  assert.equal(toE164(typed.iso, typed.national), pasted, "a pasted number round-trips");
  assert.equal(internationalPhone(toE164(typed.iso, typed.national)), pasted);
}
// A calling code that is not listed (+999 is unassigned) passes through as typed.
const unlisted = parseTyped("US", "+999 5550 1234");
assert.deepEqual(unlisted, { iso: "US", national: "+99955501234" });
assert.equal(formatNational(unlisted.iso, unlisted.national), "+99955501234");
assert.equal(toE164(unlisted.iso, unlisted.national), "+99955501234");
assert.equal(internationalPhone(toE164(unlisted.iso, unlisted.national)), "+99955501234");
// An incomplete number is still refused by the validator, not by this module.
assert.throws(() => internationalPhone(toE164("US", "555")));
assert.throws(() => internationalPhone(toE164("US", "")));

assert.equal(formatInternational("US", "2025550123"), "+1 (202) 555-0123");
assert.equal(formatInternational("GB", "07700900123"), "+44 770 090 0123");
assert.equal(formatInternational("US", "+99955501234"), "+99955501234");
console.log("Phone country list, as-you-type formatting and E.164 conversion checks passed.");
