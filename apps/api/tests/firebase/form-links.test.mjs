import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { firebaseServices } from "../support/backend.mjs";
import { FirestoreFormLinks } from "../../dist/firebase/firestore-form-links.js";
import { MemoryFormLinks, newFormLinkId } from "../../dist/form-links.js";

// The Firestore link index behaves like the local one: a link is claimed once, points at
// one form for good, and resolves to nothing when it was never claimed.
test("public form links are claimed once and resolve to one form", async () => {
  const { firestore } = await firebaseServices();
  const collection = `form_links_test_${randomUUID().replaceAll("-", "")}`;
  for (const links of [new FirestoreFormLinks(firestore, collection), new MemoryFormLinks()]) {
    const linkId = newFormLinkId("Auto quote");
    const target = { tenantId: "agency_one", formId: randomUUID() };
    assert.equal(await links.resolve(linkId), null);
    await links.claim(linkId, target);
    // A retried publish claims the same link again.
    await links.claim(linkId, target);
    assert.deepEqual(await links.resolve(linkId), target);
    await assert.rejects(links.claim(linkId, { ...target, tenantId: "agency_two" }), { code: "link_taken" });
    await assert.rejects(links.claim(linkId, { ...target, formId: randomUUID() }), { code: "link_taken" });
    assert.deepEqual(await links.resolve(linkId), target, "a refused claim changes nothing");
  }
  const links = new FirestoreFormLinks(firestore, collection);
  for (const invalid of ["", "short", "../tenants/agency_one", "UPPER-case-link", "a".repeat(80), "__reserved__"])
    assert.equal(await links.resolve(invalid), null, invalid);
  await assert.rejects(links.claim("../tenants/x", { tenantId: "agency_one", formId: "f" }), { code: "link_taken" });
  const stored = await firestore.collection(collection).get();
  assert.equal(stored.size, 1);
  assert.deepEqual(Object.keys(stored.docs[0].data()).sort(), ["createdAt", "formId", "tenantId"]);
});
