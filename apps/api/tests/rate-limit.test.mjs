import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { rateLimit } from "express-rate-limit";
import {
  rateLimitedAuthenticate,
  TokenBuckets,
  requestLimitOptions,
  admissionKey,
  CLIENT_ADDRESS_HEADER,
} from "../dist/firebase/rate-limit.js";

test("admission caps reject before authentication and cannot be reset by spoofed client headers", async (t) => {
  let authentications = 0;
  const app = express();
  app.use(rateLimit(requestLimitOptions(2)));
  app.use((_request, response) => {
    authentications++;
    response.status(401).json({ error: "unauthorized" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  for (let i = 0; i < 2; i++) assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { "x-forwarded-for": "192.0.2.44", "authorization": "Bearer fictional-other-user" } });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, "rate_limited");
  assert.ok(Number(response.headers.get("retry-after")) > 0);
  assert.equal(authentications, 2);
});

test("admission caps are per client when the web app names one, and the name can't be reset by spoofed headers", async (t) => {
  const app = express();
  app.use(rateLimit(requestLimitOptions(2)));
  app.use((_request, response) => response.status(401).json({ error: "unauthorized" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const as = (client, extra = {}) => fetch(url, { headers: { [CLIENT_ADDRESS_HEADER]: client, ...extra } }).then((r) => r.status);
  assert.deepEqual([await as("198.51.100.7"), await as("198.51.100.7")], [401, 401]);
  assert.equal(await as("198.51.100.7", { "x-forwarded-for": "192.0.2.99" }), 429, "X-Forwarded-For is ignored");
  assert.equal(await as("198.51.100.8"), 401, "another client is unaffected");
  assert.equal(await as("2001:db8:1:2::/64"), 401, "an IPv6 /64 is its own client");
  assert.equal(await fetch(url).then((r) => r.status), 401, "requests without a client share one key");
});

test("admission keys accept only addresses and /64 prefixes", () => {
  const key = (value) => admissionKey({ header: () => value });
  assert.equal(key("198.51.100.7"), "client:198.51.100.7");
  assert.equal(key("2001:DB8:1:2::/64"), "client:2001:db8:1:2::/64");
  for (const bad of [undefined, "", "not an address", "198.51.100.7, 192.0.2.1", "x".repeat(60)])
    assert.equal(key(bad), "instance");
});

test("token buckets allow a burst, refuse beyond it and refill over time", () => {
  let now = 0;
  const buckets = new TokenBuckets({ capacity: 3, refillPerSecond: 1, now: () => now });
  assert.deepEqual([1, 2, 3, 4].map(() => buckets.take("user-a")), [true, true, true, false]);
  assert.equal(buckets.take("user-b"), true, "users have separate buckets");
  now = 1000;
  assert.equal(buckets.take("user-a"), true);
  assert.equal(buckets.take("user-a"), false);
});

test("token buckets forget the least recently used keys beyond the cap", () => {
  const buckets = new TokenBuckets({ capacity: 1, refillPerSecond: 0, maxKeys: 2, now: () => 0 });
  buckets.take("a");
  buckets.take("b");
  buckets.take("c");
  assert.equal(buckets.take("a"), true, "a was evicted and starts full again");
  assert.equal(buckets.take("c"), false);
});

test("rate-limited authenticate answers 429 after authentication succeeds", () => {
  const buckets = new TokenBuckets({ capacity: 1, refillPerSecond: 0, now: () => 0 });
  const handler = rateLimitedAuthenticate(
    (_request, response, next) => {
      response.locals.amsActor = { userId: "user-a" };
      next();
    },
    (response) => response.locals.amsActor?.userId,
    buckets,
  );
  const call = () => {
    const result = { status: 200, nextCalled: false, headers: {} };
    const response = {
      locals: {},
      setHeader: (name, value) => (result.headers[name] = value),
      status(code) {
        result.status = code;
        return this;
      },
      json() {},
    };
    handler({}, response, () => (result.nextCalled = true));
    return result;
  };
  assert.deepEqual(call(), { status: 200, nextCalled: true, headers: {} });
  const limited = call();
  assert.equal(limited.status, 429);
  assert.equal(limited.nextCalled, false);
  assert.equal(limited.headers["Retry-After"], "10");
});

test("rate-limited authenticate passes authentication errors through", () => {
  const failure = new Error("unauthenticated");
  const handler = rateLimitedAuthenticate(
    (_request, _response, next) => next(failure),
    () => "user-a",
    new TokenBuckets({ capacity: 1, refillPerSecond: 0 }),
  );
  let seen;
  handler({}, { locals: {} }, (error) => (seen = error));
  assert.equal(seen, failure);
});
