import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { firebaseAuthMode } from "@/lib/server/ams-context";
import { FinishSignIn } from "@/features/agency/hosted-identity";

export const dynamic = "force-dynamic";
// The URL carries a one-time sign-in code: never send it onward as a referrer.
export const metadata: Metadata = {
  title: "Signing in · OpenAMS",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function FinishSignInPage() {
  if (!firebaseAuthMode()) notFound();
  return <FinishSignIn />;
}
