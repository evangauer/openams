import { createPublicKey, verify, type webcrypto } from "node:crypto";

/**
 * Verifies the signed header Google Identity-Aware Proxy (IAP) adds to every request it
 * lets through. The hosted preview sits behind IAP; checking the assertion here means a
 * misconfigured or bypassed proxy still can't reach the workspace.
 * https://cloud.google.com/iap/docs/signed-headers-howto
 */
export const IAP_HEADER = "x-goog-iap-jwt-assertion";
const IAP_ISSUER = "https://cloud.google.com/iap";
const IAP_KEYS_URL = "https://www.gstatic.com/iap/verify/public_key-jwk";
const CLOCK_SKEW_SECONDS = 30;

type IapKey = webcrypto.JsonWebKey & { kid?: string };
export type IapKeySource = () => Promise<IapKey[]>;

let cachedKeys: { fetchedAt: number; keys: IapKey[] } | null = null;
export const googleIapKeys: IapKeySource = async () => {
  if (cachedKeys && Date.now() - cachedKeys.fetchedAt < 60 * 60 * 1000)
    return cachedKeys.keys;
  const response = await fetch(IAP_KEYS_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`IAP keys unavailable (${response.status}).`);
  const { keys } = (await response.json()) as { keys: IapKey[] };
  cachedKeys = { fetchedAt: Date.now(), keys };
  return keys;
};

export type IapResult =
  | { ok: true; email: string; subject: string }
  | { ok: false; reason: string };

const decode = (part: string) =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

export async function verifyIapAssertion(
  token: string | null,
  options: { audience: string; keys?: IapKeySource; now?: number },
): Promise<IapResult> {
  if (!token) return { ok: false, reason: "missing assertion" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed assertion" };
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decode(parts[0]);
    claims = decode(parts[1]);
  } catch {
    return { ok: false, reason: "undecodable assertion" };
  }
  if (header.alg !== "ES256") return { ok: false, reason: "unexpected algorithm" };
  const key = (await (options.keys ?? googleIapKeys)()).find(
    (candidate) => candidate.kid === header.kid,
  );
  if (!key) return { ok: false, reason: "unknown signing key" };
  const signed = verify(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key: createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" },
    Buffer.from(parts[2], "base64url"),
  );
  if (!signed) return { ok: false, reason: "bad signature" };
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (claims.iss !== IAP_ISSUER) return { ok: false, reason: "wrong issuer" };
  if (claims.aud !== options.audience)
    return { ok: false, reason: `wrong audience ${String(claims.aud)}` };
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < now)
    return { ok: false, reason: "expired" };
  if (typeof claims.iat !== "number" || claims.iat - CLOCK_SKEW_SECONDS > now)
    return { ok: false, reason: "issued in the future" };
  if (typeof claims.email !== "string" || typeof claims.sub !== "string")
    return { ok: false, reason: "missing identity" };
  return { ok: true, email: claims.email, subject: claims.sub };
}
