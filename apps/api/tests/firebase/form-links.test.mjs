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

// An agency's forms address: one per agency, one agency per address, and never the same
// name as a form link, in Firestore as locally.
test("a forms address belongs to one agency, and an agency has one", async () => {
  const { firestore } = await firebaseServices();
  const suffix = randomUUID().replaceAll("-", "");
  const collection = `form_links_test_${suffix}`;
  const owners = `form_handles_test_${suffix}`;
  for (const links of [new FirestoreFormLinks(firestore, collection, owners), new MemoryFormLinks()]) {
    assert.equal(await links.resolveHandle("harbor-agency"), null);
    assert.equal(await links.handleOf("agency_one"), null);
    // Two requests at once: one agency gets it.
    const race = await Promise.allSettled([
      links.claimHandle("harbor-agency", "agency_one"),
      links.claimHandle("harbor-agency", "agency_one"),
    ]);
    assert.deepEqual(race.map((result) => result.status), ["fulfilled", "fulfilled"]);
    assert.equal(await links.resolveHandle("harbor-agency"), "agency_one");
    assert.equal(await links.handleOf("agency_one"), "harbor-agency");
    await assert.rejects(links.claimHandle("harbor-agency", "agency_two"), { code: "handle_taken" });
    await assert.rejects(links.claimHandle("harbor-west", "agency_one"), { code: "handle_set" });
    assert.equal(await links.resolveHandle("harbor-west"), null, "a refused claim changes nothing");
    assert.equal(await links.handleOf("agency_two"), null);
    const linkId = newFormLinkId("Auto quote");
    await links.claim(linkId, { tenantId: "agency_one", formId: "form-1" });
    await assert.rejects(links.claimHandle(linkId, "agency_two"), { code: "handle_taken" });
    await assert.rejects(links.claim("harbor-agency", { tenantId: "agency_two", formId: "form-2" }), { code: "link_taken" });
    // An address is not a link, and a link is not an address.
    assert.equal(await links.resolve("harbor-agency"), null);
    assert.equal(await links.resolveHandle(linkId), null);
  }
  const links = new FirestoreFormLinks(firestore, collection, owners);
  for (const invalid of ["", "ab", "../tenants/agency_one", "UPPER-case", "a".repeat(41)])
    assert.equal(await links.resolveHandle(invalid), null, invalid);
  await assert.rejects(links.claimHandle("../tenants/x", "agency_two"), { code: "handle_taken" });
  await assert.rejects(links.claimHandle("second-agency", "../agency_two"), { code: "handle_taken" });
  assert.deepEqual((await firestore.collection(owners).get()).docs.map((doc) => [doc.id, doc.get("handle")]), [["agency_one", "harbor-agency"]]);
});
