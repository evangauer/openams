import { NextResponse, type NextRequest } from "next/server";
import { mailboxCallbackPolicy } from "./lib/mailbox-security";

// Firebase Auth and App Check (reCAPTCHA Enterprise) endpoints, allowed ahead of the
// sign-in work so the policy doesn't need to change when it lands.
const FIREBASE_CONNECT = [
  "https://identitytoolkit.googleapis.com",
  "https://securetoken.googleapis.com",
  "https://www.googleapis.com",
  "https://firebaseinstallations.googleapis.com",
  "https://content-firebaseappcheck.googleapis.com",
];
const RECAPTCHA_SCRIPTS = ["https://www.google.com/recaptcha/", "https://www.gstatic.com/recaptcha/"];
const RECAPTCHA_CONNECT = ["https://www.google.com/recaptcha/"];
const RECAPTCHA_FRAMES = ["https://www.google.com/recaptcha/", "https://recaptcha.google.com/recaptcha/"];

// The Firebase Auth emulator (local development only). Must look like host:port so
// nothing else can be smuggled into the policy.
function authEmulatorOrigin(dev: boolean, host = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST) {
  return dev && host && /^(127\.0\.0\.1|localhost):\d{2,5}$/.test(host) ? [`http://${host}`] : [];
}

/** Hosted form pages (/f/…): the only pages another site may show in a frame. */
export const isHostedFormPath = (pathname: string) => /^\/f\/[^/]+$/.test(pathname);

export function contentSecurityPolicy(
  nonce: string,
  env = process.env.NODE_ENV,
  /** A hosted form an agency embeds in its own website. It reads no session. */
  embeddable = false,
) {
  const dev = env === "development";
  return [
    "default-src 'self'",
    // Next.js puts the nonce on its own scripts and the root layout puts it on the
    // theme boot script. React needs eval for debugging features in `next dev` only.
    [
      "script-src 'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...RECAPTCHA_SCRIPTS,
      ...(dev ? ["'unsafe-eval'"] : []),
    ].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // reCAPTCHA Enterprise reports client signals to www.google.com/recaptcha/.
    ["connect-src 'self'", ...FIREBASE_CONNECT, ...RECAPTCHA_CONNECT, ...authEmulatorOrigin(dev)].join(" "),
    // The certificate review step previews the prepared PDF in a blob: iframe.
    ["frame-src 'self' blob:", ...RECAPTCHA_FRAMES].join(" "),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    embeddable ? "frame-ancestors *" : "frame-ancestors 'none'",
    ...(env === "production" ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const callback = /^\/api\/mailbox\/callback\/(gmail|microsoft365)$/.test(request.nextUrl.pathname);
  const policy = callback
    ? mailboxCallbackPolicy(nonce)
    : contentSecurityPolicy(nonce, undefined, isHostedFormPath(request.nextUrl.pathname));
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  if (callback) response.headers.set("Referrer-Policy", "no-referrer");
  // The public demo is a copy of the app with fictional records: not for search results.
  if (process.env.AMS_PREVIEW === "public") response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|icon.svg).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
