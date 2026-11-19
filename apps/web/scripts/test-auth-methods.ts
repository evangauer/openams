import assert from "node:assert/strict";
import { runtimeSmsSignin, documentSmsSignin, internationalPhone, phoneSetupRequested, rememberTextSignIn, rememberedTextSignIn, TEXT_SIGNIN_KEY } from "../src/lib/auth-methods";
assert.equal(runtimeSmsSignin({}), false);
assert.equal(runtimeSmsSignin({ AMS_SMS_SIGNIN: "1" }), true);
for (const flag of ["1", "true", "yes", "required"]) assert.equal(runtimeSmsSignin({ AMS_SMS_SIGNIN: "1", AMS_REQUIRE_MFA: flag }), false);
assert.equal(runtimeSmsSignin({ AMS_SMS_SIGNIN: "false" }), false);
assert.equal(runtimeSmsSignin({ AMS_SMS_SIGNIN: "1", AMS_AUTH_TENANT_ID: "demo-tenant" }), false);
assert.equal(runtimeSmsSignin({ AMS_SMS_SIGNIN: "1", AMS_AUTH_TENANT_ID: "  " }), true);
assert.equal(documentSmsSignin(undefined), false);
assert.equal(internationalPhone("+1 (202) 555-0123"), "+12025550123");
for (const phone of ["2025550123", "+0123456789", "+12025550123, +12025550124", "+1", "https://example.org"]) assert.throws(() => internationalPhone(phone));
assert.equal(phoneSetupRequested("https://ams.fixture.example/sign-in/finish?phone=add"), true);
const destination = encodeURIComponent("https://ams.fixture.example/sign-in/finish?phone=add");
assert.equal(phoneSetupRequested(`https://ams.fixture.example/sign-in/finish?continueUrl=${destination}`), true);
assert.equal(phoneSetupRequested("https://ams.fixture.example/sign-in/finish?continueUrl=https%3A%2F%2Fother.example%2Fsign-in%2Ffinish%3Fphone%3Dadd"), false);
assert.equal(phoneSetupRequested("https://ams.fixture.example/sign-in/finish"), false);
// The per-browser "last sign-in had a linked number" flag: set, read, clear.
const kept = new Map<string, string>();
const storage = {
  getItem: (key: string) => kept.get(key) ?? null,
  setItem: (key: string, value: string) => void kept.set(key, value),
  removeItem: (key: string) => void kept.delete(key),
};
assert.equal(rememberedTextSignIn(storage), false);
rememberTextSignIn(true, storage);
assert.equal(kept.get(TEXT_SIGNIN_KEY), "1");
assert.equal(TEXT_SIGNIN_KEY, "openams.textSignIn");
assert.equal(rememberedTextSignIn(storage), true);
rememberTextSignIn(false, storage);
assert.equal(kept.has(TEXT_SIGNIN_KEY), false);
assert.equal(rememberedTextSignIn(storage), false);
// Only the exact value counts, and nothing but the flag is ever written.
kept.set(TEXT_SIGNIN_KEY, "true");
assert.equal(rememberedTextSignIn(storage), false);
rememberTextSignIn(true, storage);
assert.deepEqual([...kept], [[TEXT_SIGNIN_KEY, "1"]]);
// Storage that throws, and no storage at all (a server render, or a blocked browser).
const blocked = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("blocked"); },
  removeItem: () => { throw new Error("blocked"); },
};
assert.doesNotThrow(() => rememberTextSignIn(true, blocked));
assert.doesNotThrow(() => rememberTextSignIn(false, blocked));
assert.equal(rememberedTextSignIn(blocked), false);
assert.doesNotThrow(() => rememberTextSignIn(true, null));
assert.equal(rememberedTextSignIn(null), false);
assert.doesNotThrow(() => rememberTextSignIn(true));
assert.equal(rememberedTextSignIn(), false);
const hostile = Object.defineProperty({}, "localStorage", { get() { throw new Error("denied"); } });
Object.defineProperty(globalThis, "window", { value: hostile, configurable: true });
assert.doesNotThrow(() => rememberTextSignIn(true));
assert.equal(rememberedTextSignIn(), false);
Reflect.deleteProperty(globalThis, "window");
console.log("SMS policy, phone formatting, email-link setup destination and text sign-in flag checks passed.");
