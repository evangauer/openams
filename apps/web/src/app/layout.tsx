import type { Metadata } from "next";
import { headers } from "next/headers";
import { DM_Sans, Instrument_Sans, Plus_Jakarta_Sans } from "next/font/google";
import { themeBootData, themeBootScript } from "@/features/agency/appearance-bootstrap";
import { AUTH_TENANT_META, runtimeAuthTenantId } from "@/lib/auth-tenant";
import { SMS_SIGNIN_META, runtimeSmsSignin } from "@/lib/auth-methods";
import "./globals.css";

// Typefaces for the design takes under review: Plus Jakarta Sans (broker portal),
// DM Sans (Relay) and Instrument Sans (the OpenAMS brand). All SIL Open Font License.
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  display: "swap",
});
const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
});
const instrument = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
  display: "swap",
});

export const metadata: Metadata = {
  title: "OpenAMS",
  description: "Open-source agency management for independent insurance agencies.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Set per request by src/proxy.ts and allowed by its Content-Security-Policy.
  // Reading request headers also makes this layout render per request, so the runtime
  // values below come from this deployment's environment, not from the build.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  // The Identity Platform tenant this deployment signs people in through, if any. Read at
  // runtime (not NEXT_PUBLIC_) so one image can serve several deployments.
  const authTenant = runtimeAuthTenantId();
  return (
    <html
      lang="en"
      className={`${jakarta.variable} ${dmSans.variable} ${instrument.variable}`}
      data-theme="brand"
      suppressHydrationWarning
    >
      <head>
        <meta name={SMS_SIGNIN_META} content={runtimeSmsSignin() ? "1" : "0"} />
        {authTenant ? <meta name={AUTH_TENANT_META} content={authTenant} /> : null}
        <script nonce={nonce} data-appearance={themeBootData} dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
