import test from "node:test";
import assert from "node:assert/strict";
import {
  AgencyStorageQuota,
  AgencyWriteQuota,
  DEFAULT_AGENCY_LIMITS,
  agencyLimitsFromEnv,
  agencyRequestBuckets,
  agencyRequestLimit,
  agencyWriteLimit,
} from "../dist/firebase/agency-limits.js";
import { CloudStorageAmsFiles } from "../dist/firebase/storage-files.js";

const GIB = 1024 ** 3;
/** In-memory stand-in for the transactional Firestore counters. */
function memoryCounters() {
  const counts = new Map();
  let updates = 0;
  return {
    counts,
    updates: () => updates,
    async update(id, change) {
      updates++;
      counts.set(id, change(counts.get(id) ?? 0));
    },
  };
}
const day = (iso) => () => Date.parse(iso);

/** Calls an Express-style handler with a minimal response; resolves when it answers or calls next. */
function call(handler, { method = "POST", url = "/ams/commands", tenantId = "agency_a" } = {}) {
  return new Promise((resolve) => {
    const result = { status: 200, next: false, headers: {}, body: null };
    const response = {
      locals: { amsActor: tenantId ? { tenantId } : undefined },
      setHeader: (name, value) => (result.headers[name] = value),
      status(code) {
        result.status = code;
        return this;
      },
      json(body) {
        result.body = body;
        resolve(result);
      },
    };
    handler({ method, originalUrl: url }, response, (error) => {
      result.next = true;
      result.error = error;
      resolve(result);
    });
  });
}
const tenantOf = (response) => response.locals.amsActor?.tenantId;

test("agency limit settings use defaults and ignore invalid values", () => {
  assert.deepEqual(agencyLimitsFromEnv({}), DEFAULT_AGENCY_LIMITS);
  assert.deepEqual(DEFAULT_AGENCY_LIMITS, {
    requestsPerMinute: 1200,
    writesPerDay: 20_000,
    storageBytes: 5 * GIB,
  });
  assert.deepEqual(
    agencyLimitsFromEnv({
      AMS_AGENCY_REQUESTS_PER_MINUTE: " 600 ",
      AMS_AGENCY_WRITES_PER_DAY: "5000",
      AMS_AGENCY_STORAGE_GB: "20",
    }),
    { requestsPerMinute: 600, writesPerDay: 5000, storageBytes: 20 * GIB },
  );
  for (const bad of ["", "0", "-5", "1.5", "lots", "1e12", "Infinity"])
    assert.deepEqual(
      agencyLimitsFromEnv({
        AMS_AGENCY_REQUESTS_PER_MINUTE: bad,
        AMS_AGENCY_WRITES_PER_DAY: bad,
        AMS_AGENCY_STORAGE_GB: bad,
      }),
      DEFAULT_AGENCY_LIMITS,
      `invalid value ${JSON.stringify(bad)} falls back to defaults`,
    );
});

test("agency request buckets isolate agencies and answer 429 rate_limited", async () => {
  let now = 0;
  const buckets = agencyRequestBuckets({ requestsPerMinute: 2 }, () => now);
  const handler = agencyRequestLimit(tenantOf, buckets);
  assert.equal((await call(handler)).next, true);
  assert.equal((await call(handler)).next, true);
  const limited = await call(handler);
  assert.equal(limited.status, 429);
  assert.equal(limited.next, false);
  assert.equal(limited.body.error, "rate_limited");
  assert.match(limited.body.message, /too many requests/i);
  assert.equal(limited.headers["Retry-After"], "10");
  assert.equal((await call(handler, { tenantId: "agency_b" })).next, true, "another agency is unaffected");
  now = 30_000;
  assert.equal((await call(handler)).next, true, "refills at the per-minute rate");
  assert.equal((await call(handler, { tenantId: null })).next, true, "unauthenticated requests pass through");
});

test("daily write quota is per agency and resets on the next UTC day", async () => {
  const store = memoryCounters();
  let now = day("2026-03-04T23:59:00Z");
  const quota = new AgencyWriteQuota({ store, limit: 3, lease: 2, now: () => now() });
  assert.deepEqual(
    await Promise.all([1, 2, 3, 4].map(() => quota.take("agency_a"))).then((r) => r.sort()),
    [false, true, true, true],
  );
  assert.equal(await quota.take("agency_a"), false);
  assert.equal(await quota.take("agency_b"), true, "another agency has its own quota");
  assert.equal(store.counts.get("agency_writes_agency_a_2026-03-04"), 3);
  now = day("2026-03-05T00:00:01Z");
  assert.equal(await quota.take("agency_a"), true, "a new UTC day starts a new count");
  assert.equal(store.counts.get("agency_writes_agency_a_2026-03-05"), 2);
});

test("daily write quota leases writes so most writes need no counter update", async () => {
  const store = memoryCounters();
  const quota = new AgencyWriteQuota({ store, limit: 1000, lease: 25, now: day("2026-03-04T12:00:00Z") });
  for (let i = 0; i < 100; i++) assert.equal(await quota.take("agency_a"), true);
  assert.equal(store.updates(), 4);
  // Concurrent first writes share one lease request.
  const fresh = memoryCounters();
  const shared = new AgencyWriteQuota({ store: fresh, limit: 1000, lease: 25, now: day("2026-03-04T12:00:00Z") });
  await Promise.all(Array.from({ length: 10 }, () => shared.take("agency_a")));
  assert.equal(fresh.updates(), 1);
  // Two instances sharing one counter never grant more than the limit together.
  const counters = memoryCounters();
  const instances = [1, 2].map(
    () => new AgencyWriteQuota({ store: counters, limit: 30, lease: 25, now: day("2026-03-04T12:00:00Z") }),
  );
  let granted = 0;
  for (let i = 0; i < 40; i++) for (const instance of instances) if (await instance.take("agency_a")) granted++;
  assert.equal(granted, 30);
});

test("write limit charges changes only and answers 429 agency_quota_exceeded", async () => {
  const store = memoryCounters();
  const now = day("2026-03-04T18:00:00Z");
  const handler = agencyWriteLimit(
    tenantOf,
    new AgencyWriteQuota({ store, limit: 1, lease: 1, now }),
    now,
  );
  assert.equal((await call(handler, { method: "GET", url: "/ams/session" })).next, true);
  assert.equal((await call(handler, { url: "/ams/chat/pulse" })).next, true);
  assert.equal((await call(handler, { url: "/ams/chat/direct/user_b/read" })).next, true);
  assert.equal((await call(handler, { url: "/ams/import/validate" })).next, true);
  assert.equal(store.updates(), 0, "reads and background polling are not counted");
  assert.equal((await call(handler)).next, true);
  const refused = await call(handler, { url: "/ams/accounts/acct_1/documents?commandId=x" });
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, "agency_quota_exceeded");
  assert.match(refused.body.message, /resets at midnight UTC/);
  assert.equal(refused.headers["Retry-After"], String(6 * 3600));
  assert.equal((await call(handler, { tenantId: "agency_b" })).next, true);
});

test("write limit passes counter failures to the error handler", async () => {
  const failure = new Error("contention");
  const handler = agencyWriteLimit(
    tenantOf,
    new AgencyWriteQuota({ store: { update: async () => { throw failure; } }, limit: 10 }),
  );
  const result = await call(handler);
  assert.equal(result.error, failure);
});

test("storage quota reserves, releases and refuses over the limit per agency", async () => {
  const store = memoryCounters();
  const quota = new AgencyStorageQuota({ store, limitBytes: 100 });
  await quota.reserve("agency_a", 60);
  await quota.reserve("agency_a", 40);
  await assert.rejects(quota.reserve("agency_a", 1), (error) => {
    assert.equal(error.status, 413);
    assert.equal(error.code, "storage_quota_exceeded");
    return true;
  });
  assert.equal(store.counts.get("agency_storage_agency_a"), 100, "a refused upload is not counted");
  await quota.reserve("agency_b", 100);
  await quota.release("agency_a", 60);
  await quota.reserve("agency_a", 50);
  assert.equal(store.counts.get("agency_storage_agency_a"), 90);
  await quota.release("agency_a", 1000);
  assert.equal(store.counts.get("agency_storage_agency_a"), 0, "never below zero");
});

/** A fake bucket: objects in a Map, honoring the create-only precondition. */
function fakeBucket({ failSave } = {}) {
  const objects = new Map();
  const notFound = () => Object.assign(new Error("not found"), { code: 404 });
  return {
    objects,
    file: (key) => ({
      async download() {
        if (!objects.has(key)) throw notFound();
        return [objects.get(key)];
      },
      async save(bytes) {
        if (failSave) throw Object.assign(new Error("unavailable"), { code: 503 });
        if (objects.has(key)) throw Object.assign(new Error("precondition"), { code: 412 });
        objects.set(key, Buffer.from(bytes));
      },
    }),
  };
}

test("cloud storage files charge new objects to the agency in the key", async () => {
  const store = memoryCounters();
  const bucket = fakeBucket();
  const files = new CloudStorageAmsFiles(bucket, {
    quota: new AgencyStorageQuota({ store, limitBytes: 10 }),
  });
  await files.put("ams-documents/agency_a/cmd_1/hash1", Buffer.from("123456"), "text/plain");
  await files.put("ams-documents/agency_a/cmd_1/hash1", Buffer.from("123456"), "text/plain");
  assert.equal(store.counts.get("agency_storage_agency_a"), 6, "an identical retry is not charged twice");
  await assert.rejects(
    files.put("ams-documents/agency_a/cmd_2/hash2", Buffer.from("12345"), "text/plain"),
    (error) => error.code === "storage_quota_exceeded",
  );
  assert.equal(bucket.objects.has("ams-documents/agency_a/cmd_2/hash2"), false);
  await files.put("ams-documents/agency_b/cmd_2/hash2", Buffer.from("12345"), "text/plain");
  assert.equal(store.counts.get("agency_storage_agency_b"), 5);

  const failing = new CloudStorageAmsFiles(fakeBucket({ failSave: true }), {
    quota: new AgencyStorageQuota({ store, limitBytes: 10 }),
  });
  await assert.rejects(failing.put("ams-documents/agency_c/cmd_3/hash3", Buffer.from("1234"), "text/plain"));
  assert.equal(store.counts.get("agency_storage_agency_c"), 0, "a failed write releases its reservation");
});
