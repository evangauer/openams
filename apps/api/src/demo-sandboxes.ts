import { createHash } from "node:crypto";
import type { AmsDemoInfo } from "./local-demo.js";
import { AmsError } from "./repository.js";

/**
 * The public demo (AMS_PREVIEW=public): every visitor gets a private copy of the
 * fictional agency, held by a random token in their browser's cookie. A sandbox lives
 * for a fixed time, then its records are deleted. Nothing here is durable: the registry
 * is in memory, so a restart ends every sandbox.
 */
export const SANDBOX_TOKEN = /^sbx_[a-f0-9]{64}$/;

export interface DemoSandbox {
  tenantId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  info: AmsDemoInfo;
  /** Requests in the current minute, and changes over the sandbox's life. */
  minute: number;
  requests: number;
  writes: number;
}

export interface DemoSandboxOptions {
  /** Fills a new tenant with the fictional agency. */
  seed: (input: {
    tenantId: string;
    commandId: string;
    startedAt: string;
  }) => Promise<AmsDemoInfo>;
  /** Deletes everything a tenant stored. */
  remove: (tenantId: string) => Promise<void>;
  /** How long a sandbox lives. */
  ttlMs: number;
  /** Most sandboxes alive at once. */
  max: number;
  /** Most sandboxes created per minute, across all visitors. */
  perMinute: number;
  /** Requests one sandbox may make per minute, and changes over its life. */
  requestsPerMinute?: number;
  maxWrites?: number;
  /** At the cap, a sandbox nobody has used for this long makes room for a new visitor. */
  idleMs?: number;
  now?: () => number;
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
/** A tenant id no visitor can guess from another's: it comes from the secret token. */
export const sandboxTenantId = (token: string) =>
  `local_demo_${digest(`sandbox:${token}`).slice(0, 24)}`;

export class DemoSandboxes {
  private byKey = new Map<string, DemoSandbox>();
  private byTenant = new Map<string, DemoSandbox>();
  private pending = new Map<string, Promise<DemoSandbox>>();
  private created: number[] = [];
  private now: () => number;
  private idleMs: number;
  constructor(private options: DemoSandboxOptions) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? 15 * 60 * 1000;
  }

  /** The sandbox a token opens, or null when there is none or it has expired. */
  find(token: string): DemoSandbox | null {
    if (!SANDBOX_TOKEN.test(token)) return null;
    const sandbox = this.byKey.get(digest(token));
    if (!sandbox || sandbox.expiresAt <= this.now()) return null;
    sandbox.lastSeenAt = this.now();
    return sandbox;
  }
  /**
   * Counts one request against a sandbox. A demo is for looking around: these bounds
   * keep one visitor, or a script, from filling the server everyone shares.
   */
  admit(sandbox: DemoSandbox, write: boolean) {
    const minute = Math.floor(this.now() / 60_000);
    if (sandbox.minute !== minute)
      Object.assign(sandbox, { minute, requests: 0 });
    if (++sandbox.requests > (this.options.requestsPerMinute ?? 600))
      throw new AmsError(
        429,
        "rate_limited",
        "Too many requests. Wait a few seconds and try again.",
      );
    if (write && ++sandbox.writes > (this.options.maxWrites ?? 3000))
      throw new AmsError(
        429,
        "demo_limit",
        "This demo has reached its limit of changes. Nothing was saved. Start a fresh demo to keep exploring.",
      );
  }
  info(tenantId: string) {
    const sandbox = this.byTenant.get(tenantId);
    return sandbox && sandbox.expiresAt > this.now() ? sandbox.info : null;
  }
  has(tenantId: string) {
    return this.info(tenantId) !== null;
  }
  tenants() {
    return [...this.byTenant.keys()];
  }
  get size() {
    return this.byKey.size;
  }

  /**
   * Opens a sandbox for a new token. `replaces` is the visitor's previous token, if any:
   * that sandbox is deleted, so "start over" doesn't leave a second copy behind.
   */
  create(token: string, replaces?: string | null): Promise<DemoSandbox> {
    if (!SANDBOX_TOKEN.test(token))
      return Promise.reject(
        new AmsError(400, "invalid_request", "Invalid demo session."),
      );
    const key = digest(token);
    const existing = this.byKey.get(key);
    if (existing) return Promise.resolve(existing);
    // Registered before the first await, so two requests with one token share one sandbox.
    const pending = this.pending.get(key);
    if (pending) return pending;
    const work = this.open(token, key, replaces ?? null).finally(() =>
      this.pending.delete(key),
    );
    this.pending.set(key, work);
    return work;
  }
  private async open(
    token: string,
    key: string,
    replaces: string | null,
  ): Promise<DemoSandbox> {
    await this.sweep();
    if (replaces && replaces !== token && SANDBOX_TOKEN.test(replaces))
      await this.drop(digest(replaces));

    const now = this.now();
    this.created = this.created.filter((at) => now - at < 60_000);
    if (this.created.length >= this.options.perMinute)
      throw new AmsError(
        429,
        "demo_busy",
        "The demo is busy right now. Try again in a minute.",
      );
    // This request is already counted in `pending`.
    if (this.byKey.size + this.pending.size > this.options.max) {
      // Make room with the sandbox left alone the longest, if it really is idle.
      const [idleKey, idle] =
        [...this.byKey.entries()].sort(
          (a, b) => a[1].lastSeenAt - b[1].lastSeenAt,
        )[0] ?? [];
      if (!idleKey || !idle || now - idle.lastSeenAt < this.idleMs)
        throw new AmsError(
          429,
          "demo_busy",
          "The demo is busy right now. Try again in a few minutes.",
        );
      await this.drop(idleKey);
    }
    this.created.push(now);

    const tenantId = sandboxTenantId(token);
    try {
      const info = await this.options.seed({
        tenantId,
        commandId: `sandbox:${key}`,
        startedAt: new Date(now).toISOString(),
      });
      const sandbox: DemoSandbox = {
        tenantId,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + this.options.ttlMs,
        info,
        minute: 0,
        requests: 0,
        writes: 0,
      };
      this.byKey.set(key, sandbox);
      this.byTenant.set(tenantId, sandbox);
      return sandbox;
    } catch (error) {
      await this.options.remove(tenantId).catch(() => undefined);
      throw error;
    }
  }

  private async drop(key: string) {
    const sandbox = this.byKey.get(key);
    if (!sandbox) return;
    this.byKey.delete(key);
    this.byTenant.delete(sandbox.tenantId);
    await this.options.remove(sandbox.tenantId);
  }
  /** Deletes expired sandboxes. Returns how many went. */
  async sweep() {
    const now = this.now();
    const expired = [...this.byKey.entries()].filter(
      ([, sandbox]) => sandbox.expiresAt <= now,
    );
    for (const [key] of expired) await this.drop(key).catch(() => undefined);
    return expired.length;
  }
}
