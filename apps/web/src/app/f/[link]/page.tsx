import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AgencyForms } from "@/features/forms/agency-forms";
import { loadPublicAgency, loadPublicForm } from "@/lib/server/public-forms";
import { HostedForm, hostedFormMetadata } from "../hosted-form";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ link: string }>;
  searchParams: Promise<{ embed?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { link } = await params;
  const view = await loadPublicForm(link);
  if (view) return hostedFormMetadata(view);
  const agency = await loadPublicAgency(link);
  if (!agency) return hostedFormMetadata(null);
  return {
    title: `${agency.name} · Forms`,
    // An agency shares its address itself; it doesn't belong in search results.
    robots: { index: false, follow: false },
  };
}

/**
 * /f/<link>: a hosted form at its public link or, when no form has that link, the page
 * of an agency's live forms at its forms address. Anyone can open either; no one signs in.
 */
export default async function HostedFormPage({ params, searchParams }: Props) {
  const { link } = await params;
  const view = await loadPublicForm(link);
  if (view) return <HostedForm view={view} embed={(await searchParams).embed === "1"} />;
  const agency = await loadPublicAgency(link);
  if (!agency) notFound();
  return <AgencyForms agency={agency} />;
}
