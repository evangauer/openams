// Per-deployment runtime settings for the Firebase mode (docs/cloud-run.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authTenantId,
  configuredAppOrigin,
  configuredAppUrl,
  firestoreDatabaseId,
} from "../dist/firebase/deployment-config.js";

test("the public origin prefers AMS_APP_URL over NEXT_PUBLIC_APP_URL", () => {
  assert.equal(configuredAppUrl({}), undefined);
  assert.equal(configuredAppOrigin({}), undefined);
  assert.equal(
    configuredAppOrigin({ NEXT_PUBLIC_APP_URL: "https://built.example.test/" }),
    "https://built.example.test",
  );
  assert.equal(
    configuredAppOrigin({
      AMS_APP_URL: "https://agency-a.example.test/path",
      NEXT_PUBLIC_APP_URL: "https://built.example.test",
    }),
    "https://agency-a.example.test",
  );
  assert.equal(
    configuredAppOrigin({ AMS_APP_URL: " ", NEXT_PUBLIC_APP_URL: "https://built.example.test" }),
    "https://built.example.test",
  );
  assert.throws(() => configuredAppOrigin({ AMS_APP_URL: "not a url" }), /valid URL/);
});

test("a named Firestore database is optional and validated", () => {
  assert.equal(firestoreDatabaseId({}), undefined);
  assert.equal(firestoreDatabaseId({ AMS_FIRESTORE_DATABASE: "" }), undefined);
  assert.equal(firestoreDatabaseId({ AMS_FIRESTORE_DATABASE: "(default)" }), undefined);
  assert.equal(firestoreDatabaseId({ AMS_FIRESTORE_DATABASE: "agency-a" }), "agency-a");
  for (const bad of ["ab", "Agency-A", "1agency", "agency-", "agency_a", "a".repeat(64)])
    assert.throws(() => firestoreDatabaseId({ AMS_FIRESTORE_DATABASE: bad }), /AMS_FIRESTORE_DATABASE/, bad);
});

test("an Identity Platform tenant is optional and validated", () => {
  assert.equal(authTenantId({}), undefined);
  assert.equal(authTenantId({ AMS_AUTH_TENANT_ID: " " }), undefined);
  assert.equal(authTenantId({ AMS_AUTH_TENANT_ID: "agency-a-1x2y3" }), "agency-a-1x2y3");
  for (const bad of ["-agency", "agency a", "agency/a"])
    assert.throws(() => authTenantId({ AMS_AUTH_TENANT_ID: bad }), /AMS_AUTH_TENANT_ID/, bad);
});
