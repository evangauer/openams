/**
 * Defense-in-depth CSRF check for cookie-authenticated mutations.
 * Browser requests must not be cross-site, and any supplied Origin must match
 * the direct or trusted reverse-proxy host serving this request.
 */
export function mutationOriginAllowed(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") return false;

  const origin = request.headers.get("origin");
  if (!origin) {
    // Non-browser clients do not automatically carry SameSite cookies. JSON
    // content-type validation provides a second barrier for form submissions.
    return fetchSite === undefined || fetchSite === "same-origin";
  }

  let normalizedOrigin: string;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    return false;
  }

  const allowed = new Set<string>();
  try {
    allowed.add(new URL(request.url).origin);
  } catch {
    return false;
  }

  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost && safeHost(forwardedHost)) {
    const forwardedProto = request.headers.get("x-forwarded-proto")?.toLowerCase();
    const protocol = forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : new URL(request.url).protocol.replace(":", "");
    allowed.add(`${protocol}://${forwardedHost}`);
  }

  const host = request.headers.get("host");
  if (host && safeHost(host)) {
    allowed.add(`${new URL(request.url).protocol}//${host}`);
    // Behind an HTTPS proxy (the hosted preview on Cloud Run) the app sees plain HTTP.
    const proto = request.headers.get("x-forwarded-proto")?.toLowerCase();
    if (proto === "http" || proto === "https") allowed.add(`${proto}://${host}`);
  }

  for (const configured of configuredOrigins(configuredAppUrl())) {
    allowed.add(configured);
  }
  return allowed.has(normalizedOrigin);
}

/**
 * The configured public origin(s). AMS_APP_URL is read at runtime; NEXT_PUBLIC_APP_URL is
 * inlined into the server bundle at build time, so it can't vary between deployments
 * that share one image. AMS_APP_URL wins when set (docs/cloud-run.md).
 */
export function configuredAppUrl(
  env: Record<string, string | undefined> = {
    AMS_APP_URL: process.env.AMS_APP_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  },
): string | undefined {
  return env.AMS_APP_URL?.trim() || env.NEXT_PUBLIC_APP_URL?.trim() || undefined;
}

function configuredOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((candidate) => {
      try {
        return new URL(candidate).origin;
      } catch {
        return null;
      }
    })
    .filter((candidate): candidate is string => candidate !== null);
}

function safeHost(host: string): boolean {
  return /^[A-Za-z0-9.[\]:_-]+$/.test(host) && !host.includes("@");
}
