import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { firebaseAuthMode } from "@/lib/server/ams-context";
import { HostedJoin } from "@/features/agency/hosted-identity";

export const dynamic = "force-dynamic";
// The invitation's secret is after "#" in the URL; the page reads it and removes it.
export const metadata: Metadata = {
  title: "Join an agency · OpenAMS",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function JoinPage() {
  if (!firebaseAuthMode()) notFound();
  return <HostedJoin />;
}
