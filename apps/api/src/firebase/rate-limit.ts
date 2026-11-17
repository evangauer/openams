import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Options } from "express-rate-limit";

/**
 * The header naming the client the web app is forwarding for. The API listens only on
 * loopback and the web app builds every forwarded request's headers itself, so only the
 * web app can set it. X-Forwarded-For is never read here.
 */
export const CLIENT_ADDRESS_HEADER = "x-openams-client";
const CLIENT_KEY = /^[0-9a-f.:]{2,45}(\/64)?$/i;

/**
 * The admission-limit key for a request: the client the web app named (an IPv4 address
 * or an IPv6 /64), so one client exhausting its limit never refuses anyone else. When the
 * deployment does not say where the client address is (AMS_CLIENT_ADDRESS_DEPTH on the web
 * app), every request shares one key per process, as one coarse bound.
 */
export function admissionKey(request: Pick<Request, "header">): string {
  const client = request.header(CLIENT_ADDRESS_HEADER);
  return client && CLIENT_KEY.test(client) ? `client:${client.toLowerCase()}` : "instance";
}

/** Per-process admission cap before expensive authentication, per client when known
 * (see admissionKey), in addition to signed-in per-user buckets.
 */
export function requestLimitOptions(limit: number): Partial<Options> {
  return {
    windowMs: 60_000,
    limit,
    keyGenerator: (request) => admissionKey(request),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "rate_limited", message: "Too many requests. Wait a minute and try again." },
  };
}

/**
 * Per-key token buckets held in this process. Each application instance keeps its own
 * buckets, so the effective ceiling is the limit times the instance count; this bounds
 * what one signed-in user can make a single instance do, not a global quota.
 */
export class TokenBuckets {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private options: {
      /** Requests allowed in a burst. */
      capacity: number;
      /** Tokens added per second. */
      refillPerSecond: number;
      /** Most keys tracked; the least recently used are dropped beyond this. */
      maxKeys?: number;
      now?: () => number;
    },
  ) {}
  take(key: string, cost = 1): boolean {
    const now = (this.options.now ?? Date.now)();
    const { capacity, refillPerSecond } = this.options;
    const current = this.buckets.get(key) ?? { tokens: capacity, at: now };
    this.buckets.delete(key);
    const tokens = Math.min(
      capacity,
      current.tokens + ((now - current.at) / 1000) * refillPerSecond,
    );
    const allowed = tokens >= cost;
    this.buckets.set(key, {
      tokens: allowed ? tokens - cost : tokens,
      at: now,
    });
    const maxKeys = this.options.maxKeys ?? 10_000;
    while (this.buckets.size > maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    return allowed;
  }
}

/** Runs `authenticate`, then charges the signed-in user's bucket (keyed by `key`). */
export function rateLimitedAuthenticate(
  authenticate: RequestHandler,
  key: (response: Response) => string | undefined,
  buckets: TokenBuckets,
): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    authenticate(request, response, (error?: unknown) => {
      if (error) return next(error);
      const id = key(response);
      if (id && !buckets.take(id)) {
        response.setHeader("Retry-After", "10");
        response.status(429).json({
          error: "rate_limited",
          message: "Too many requests. Wait a few seconds and try again.",
        });
        return;
      }
      next();
    });
  };
}
