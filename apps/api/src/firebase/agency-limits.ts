import type { RequestHandler, Response } from "express";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { AmsError } from "../repository.js";
import { IDENTITY_COLLECTIONS } from "./identity.js";
import { TokenBuckets } from "./rate-limit.js";

/**
 * Per-agency protective limits for a deployment that hosts several agencies (open
 * sign-up). They are enforced inside each agency's own request path and keyed by the
 * server-derived tenant; no API reads the counters back (docs/limits.md).
 */
export interface AgencyLimits {
  /** Requests one agency may make per minute (each API instance; bursts up to a minute's worth). */
  requestsPerMinute: number;
  /** Changes (POST/PUT/PATCH/DELETE) one agency may make per UTC day. */
  writesPerDay: number;
  /** Stored document bytes one agency may keep. */
  storageBytes: number;
}
const GIB = 1024 ** 3;
export const DEFAULT_AGENCY_LIMITS: AgencyLimits = {
  requestsPerMinute: 1200,
  writesPerDay: 20_000,
  storageBytes: 5 * GIB,
};
/**
 * Reads AMS_AGENCY_REQUESTS_PER_MINUTE, AMS_AGENCY_WRITES_PER_DAY and
 * AMS_AGENCY_STORAGE_GB (whole GiB). Missing or invalid values use the defaults.
 */
export function agencyLimitsFromEnv(
  env: Record<string, string | undefined> = process.env,
): AgencyLimits {
  const positive = (value: string | undefined, fallback: number, max: number) => {
    const parsed = Number(value?.trim() || undefined);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
  };
  return {
    requestsPerMinute: positive(
      env.AMS_AGENCY_REQUESTS_PER_MINUTE,
      DEFAULT_AGENCY_LIMITS.requestsPerMinute,
      1_000_000,
    ),
    writesPerDay: positive(
      env.AMS_AGENCY_WRITES_PER_DAY,
      DEFAULT_AGENCY_LIMITS.writesPerDay,
      100_000_000,
    ),
    storageBytes:
      positive(env.AMS_AGENCY_STORAGE_GB, DEFAULT_AGENCY_LIMITS.storageBytes / GIB, 1_000_000) * GIB,
  };
}

/** One token bucket per agency, refilled at `requestsPerMinute` with a minute's burst. */
export const agencyRequestBuckets = (limits: Pick<AgencyLimits, "requestsPerMinute">, now?: () => number) =>
  new TokenBuckets({
    capacity: limits.requestsPerMinute,
    refillPerSecond: limits.requestsPerMinute / 60,
    now,
  });

/** A durable counter changed atomically: `change` maps the current count to the new one. */
export interface CounterStore {
  update(id: string, change: (count: number) => number): Promise<void>;
}
/** Counters in `identity_limits/{id}` (field `count`), changed in a Firestore transaction. */
export function firestoreCounters(db: Firestore): CounterStore {
  return {
    async update(id, change) {
      const ref = db.collection(IDENTITY_COLLECTIONS.limits).doc(id);
      await db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        const count = Number(doc.get("count") ?? 0);
        const next = change(Number.isFinite(count) ? count : 0);
        if (next !== count) tx.set(ref, { count: next, updatedAt: Timestamp.now() });
      });
    },
  };
}

const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);
const secondsToMidnightUtc = (at: number) => {
  const midnight = new Date(at);
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((midnight.getTime() - at) / 1000));
};

/**
 * Daily write quota per agency. Instead of a transaction per write, each process leases
 * a block of `lease` writes from the agency's day counter in one transaction and spends
 * it locally. A lease that is not used up (another instance, a restart) still counts, so
 * an agency can be refused up to `lease` writes per instance before the exact limit.
 */
export class AgencyWriteQuota {
  private leases = new Map<string, { day: string; remaining: number; exhausted: boolean }>();
  private pending = new Map<string, Promise<void>>();
  constructor(
    private options: {
      store: CounterStore;
      limit: number;
      lease?: number;
      maxKeys?: number;
      now?: () => number;
    },
  ) {}
  /** Spends one write for the agency; false once today's limit is reached. */
  async take(tenantId: string): Promise<boolean> {
    const day = utcDay((this.options.now ?? Date.now)());
    // Concurrent requests share one renewal. Each renewal either raises the day's count
    // or marks it exhausted, so this ends by the time the limit is reached.
    for (;;) {
      const lease = this.leases.get(tenantId);
      if (lease?.day === day) {
        if (lease.remaining > 0) {
          lease.remaining--;
          return true;
        }
        if (lease.exhausted) return false;
      }
      await this.renew(tenantId, day);
    }
  }
  private renew(tenantId: string, day: string) {
    const key = `${tenantId}\n${day}`;
    let running = this.pending.get(key);
    if (!running) {
      running = (async () => {
        const { limit, store } = this.options;
        const want = Math.max(1, this.options.lease ?? 25);
        let granted = 0;
        await store.update(`agency_writes_${tenantId}_${day}`, (count) => {
          granted = Math.max(0, Math.min(want, limit - count));
          return count + granted;
        });
        this.leases.delete(tenantId);
        this.leases.set(tenantId, { day, remaining: granted, exhausted: granted === 0 });
        const maxKeys = this.options.maxKeys ?? 10_000;
        while (this.leases.size > maxKeys) {
          const oldest = this.leases.keys().next().value;
          if (oldest === undefined) break;
          this.leases.delete(oldest);
        }
      })().finally(() => this.pending.delete(key));
      this.pending.set(key, running);
    }
    return running;
  }
}

/**
 * Stored-bytes quota per agency, kept in `identity_limits/agency_storage_<tenant>`.
 * Bytes are reserved before an object is written and released if the write does not
 * create a new object. Files stored before the quota existed are not counted.
 */
export class AgencyStorageQuota {
  constructor(private options: { store: CounterStore; limitBytes: number }) {}
  private id = (tenantId: string) => `agency_storage_${tenantId}`;
  async reserve(tenantId: string, bytes: number): Promise<void> {
    let allowed = false;
    await this.options.store.update(this.id(tenantId), (count) => {
      allowed = count + bytes <= this.options.limitBytes;
      return allowed ? count + bytes : count;
    });
    if (!allowed)
      throw new AmsError(
        413,
        "storage_quota_exceeded",
        "Your agency has reached its document storage limit, so this file was not saved.",
      );
  }
  async release(tenantId: string, bytes: number): Promise<void> {
    await this.options.store.update(this.id(tenantId), (count) => Math.max(0, count - bytes));
  }
}

type Tenant = (response: Response) => string | undefined;
/** After authentication: charges the agency's request bucket. */
export function agencyRequestLimit(tenant: Tenant, buckets: TokenBuckets): RequestHandler {
  return (_request, response, next) => {
    const id = tenant(response);
    if (id && !buckets.take(id)) {
      response.setHeader("Retry-After", "10");
      response.status(429).json({
        error: "rate_limited",
        message: "Your agency is sending too many requests. Wait a few seconds and try again.",
      });
      return;
    }
    next();
  };
}
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Background polling and read-only checks sent as POST: the request bucket bounds them.
const UNCOUNTED = /^\/ams\/(chat\/pulse|chat\/(team|direct\/[^/]+)\/read|import\/validate|upload-check)$/;
/** After authentication and access control: charges one change to the agency's day. */
export function agencyWriteLimit(
  tenant: Tenant,
  quota: AgencyWriteQuota,
  now: () => number = Date.now,
): RequestHandler {
  return (request, response, next) => {
    const id = tenant(response);
    const path = request.originalUrl.split("?")[0] ?? "";
    if (!id || !MUTATING.has(request.method) || UNCOUNTED.test(path)) return next();
    quota.take(id).then((allowed) => {
      if (allowed) return next();
      response.setHeader("Retry-After", String(secondsToMidnightUtc(now())));
      response.status(429).json({
        error: "agency_quota_exceeded",
        message:
          "Your agency has reached its daily limit of changes. Nothing was saved. The limit resets at midnight UTC.",
      });
    }, next);
  };
}
