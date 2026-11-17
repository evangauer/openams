import { isIP } from "node:net";

/**
 * The header the web app sets on requests it forwards to the API, naming the client the
 * API's admission limits should charge. The API listens only on loopback and the web app
 * builds every forwarded request's headers itself, so a browser cannot set this header.
 */
export const CLIENT_ADDRESS_HEADER = "x-openams-client";

/**
 * AMS_CLIENT_ADDRESS_DEPTH: where the client's address sits in X-Forwarded-For, counted
 * from the end (1 = the last entry). Only the entries your own proxies append can be
 * trusted; anything before them came from the client. A single reverse proxy that appends
 * the client address is 1; a Google Cloud external Application Load Balancer, which
 * appends the client address and then its own, is 2. Unset or 0: no address is trusted,
 * and every client shares one admission limit per instance.
 */
export function clientAddressDepth(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = env.AMS_CLIENT_ADDRESS_DEPTH?.trim();
  if (!value || !/^[0-9]$/.test(value)) return 0;
  return Number(value);
}

/**
 * The client's address from X-Forwarded-For at the configured depth, as a limit key:
 * an IPv4 address, or the /64 prefix of an IPv6 address (one subscriber usually holds a
 * whole /64, so a single address would be trivial to rotate). Null when no address can
 * be trusted.
 */
export function clientAddress(
  forwardedFor: string | null,
  depth: number,
): string | null {
  if (!depth || !forwardedFor || forwardedFor.length > 4096) return null;
  const entries = forwardedFor.split(",").map((entry) => entry.trim());
  if (entries.length < depth) return null;
  return limitKey(entries[entries.length - depth]);
}

function limitKey(address: string): string | null {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) address = mapped;
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6) return null;
  const [head, tail = ""] = address.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  if (right.some((group) => group.includes("."))) return null;
  const groups = address.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  if (groups.length !== 8) return null;
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}

/** Headers naming the client for the API's admission limits, when one can be trusted. */
export function clientAddressHeaders(request: Request): Record<string, string> {
  const address = clientAddress(
    request.headers.get("x-forwarded-for"),
    clientAddressDepth(),
  );
  return address ? { [CLIENT_ADDRESS_HEADER]: address } : {};
}
