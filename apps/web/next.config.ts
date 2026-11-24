import type { NextConfig } from "next";
import path from "node:path";

const isProd = process.env.NODE_ENV === "production";

// Firebase App Hosting provides the web app's (public) Firebase config at build time.
// Explicit NEXT_PUBLIC_FIREBASE_* values win, so other hosts and the emulators work too.
function firebaseWebEnv(): Record<string, string> {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(process.env.FIREBASE_WEBAPP_CONFIG || "{}");
  } catch {
    return {};
  }
  const pick = (name: string, key: string) => {
    const value = process.env[name] || config[key];
    return typeof value === "string" && value ? { [name]: value } : {};
  };
  return {
    ...pick("NEXT_PUBLIC_FIREBASE_API_KEY", "apiKey"),
    ...pick("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "authDomain"),
    ...pick("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "projectId"),
    ...pick("NEXT_PUBLIC_FIREBASE_APP_ID", "appId"),
  };
}

const nextConfig: NextConfig = {
  // The npm workspace root holds the lockfile; pin it so Next doesn't guess.
  turbopack: {
    root: path.join(import.meta.dirname, "../.."),
  },
  env: firebaseWebEnv(),
  devIndicators: false,
  // Don't let `next dev` write an AGENTS.md into the workspace; the repo has its own.
  agentRules: false,
  poweredByHeader: false,
  // The Content-Security-Policy is set per request in src/proxy.ts (it carries a nonce).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), display-capture=()",
          },
          // Browsers ignore HSTS over plain http, so local evaluation is unaffected.
          ...(isProd
            ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
            : []),
        ],
      },
      {
        // Nothing may be framed except a hosted form (/f/…), which an agency can embed
        // in its own website; src/proxy.ts sets the matching frame-ancestors policy.
        source: "/((?!f/).*)",
        headers: [{ key: "X-Frame-Options", value: "DENY" }],
      },
      {
        // Email sign-in links carry a one-time code in the URL.
        source: "/sign-in/finish",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default nextConfig;
