// Runtime per-deployment settings: the public origin (AMS_APP_URL over the build-time
// NEXT_PUBLIC_APP_URL) and the Identity Platform tenant handed to the browser.
import assert from "node:assert/strict";
import { configuredAppUrl, mutationOriginAllowed } from "../src/lib/request-origin";
import {
  AUTH_TENANT_META,
  documentAuthTenantId,
  runtimeAuthTenantId,
} from "../src/lib/auth-tenant";

// Origin resolution prefers the runtime value and falls back to the build-time one.
assert.equal(configuredAppUrl({}), undefined);
assert.equal(configuredAppUrl({ NEXT_PUBLIC_APP_URL: "https://built.example.test" }), "https://built.example.test");
assert.equal(
  configuredAppUrl({
    AMS_APP_URL: " https://agency-a.example.test ",
    NEXT_PUBLIC_APP_URL: "https://built.example.test",
  }),
  "https://agency-a.example.test",
);
assert.equal(configuredAppUrl({ AMS_APP_URL: "  ", NEXT_PUBLIC_APP_URL: "https://built.example.test" }), "https://built.example.test");

// The CSRF origin check reads AMS_APP_URL when called, not when the module loaded.
const mutation = (origin: string) =>
  new Request("http://127.0.0.1:8080/api/agency/clients", {
    method: "POST",
    headers: { origin, host: "127.0.0.1:8080", "sec-fetch-site": "same-site" },
  });
delete process.env.AMS_APP_URL;
delete process.env.NEXT_PUBLIC_APP_URL;
assert.equal(mutationOriginAllowed(mutation("https://agency-a.example.test")), false);
process.env.AMS_APP_URL = "https://agency-a.example.test/some/path";
assert.equal(mutationOriginAllowed(mutation("https://agency-a.example.test")), true);
assert.equal(mutationOriginAllowed(mutation("https://agency-b.example.test")), false);
process.env.AMS_APP_URL = "https://agency-b.example.test";
assert.equal(mutationOriginAllowed(mutation("https://agency-a.example.test")), false);
assert.equal(mutationOriginAllowed(mutation("https://agency-b.example.test")), true);
// The runtime value replaces the build-time one rather than adding to it.
process.env.NEXT_PUBLIC_APP_URL = "https://built.example.test";
assert.equal(mutationOriginAllowed(mutation("https://built.example.test")), false);
delete process.env.AMS_APP_URL;
assert.equal(mutationOriginAllowed(mutation("https://built.example.test")), true);
delete process.env.NEXT_PUBLIC_APP_URL;

// The tenant id: published only when well formed.
assert.equal(runtimeAuthTenantId(undefined), null);
assert.equal(runtimeAuthTenantId(""), null);
assert.equal(runtimeAuthTenantId("agency-a-tenant"), "agency-a-tenant");
assert.equal(runtimeAuthTenantId(' agency-a-tenant '), "agency-a-tenant");
assert.equal(runtimeAuthTenantId('"><script>'), null);
assert.equal(runtimeAuthTenantId("-leading-hyphen"), null);
process.env.AMS_AUTH_TENANT_ID = "agency-b-tenant";
assert.equal(runtimeAuthTenantId(), "agency-b-tenant");
delete process.env.AMS_AUTH_TENANT_ID;
assert.equal(runtimeAuthTenantId(), null);

// The browser reads it back from the layout's <meta> tag.
const fakeDocument = (content: string | null) => ({
  querySelector(selector: string) {
    assert.equal(selector, `meta[name="${AUTH_TENANT_META}"]`);
    return content === null ? null : { getAttribute: (name: string) => (name === "content" ? content : null) };
  },
}) as unknown as Pick<Document, "querySelector">;
assert.equal(documentAuthTenantId(fakeDocument("agency-a-tenant")), "agency-a-tenant");
assert.equal(documentAuthTenantId(fakeDocument(null)), null);
assert.equal(documentAuthTenantId(fakeDocument("not a tenant")), null);
assert.equal(documentAuthTenantId(undefined), null);
assert.equal(documentAuthTenantId(), null); // no document under Node

console.log("runtime config checks passed");
