import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadPublicAgency, loadPublicForm } from "@/lib/server/public-forms";
import { HostedForm, hostedFormMetadata } from "../../hosted-form";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ link: string; form: string }>;
  searchParams: Promise<{ embed?: string }>;
};

/** The form an agency's readable address names: its newest live form with that name. */
async function formAt({ params }: Pick<Props, "params">) {
  const { link: handle, form: path } = await params;
  const agency = await loadPublicAgency(handle);
  const form = agency?.forms.find((item) => item.path === path);
  return form ? loadPublicForm(form.linkId) : null;
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  return hostedFormMetadata(await formAt(props));
}

/**
 * /f/<agency>/<form>: a hosted form at its readable address. The page is the one at
 * /f/<link>; answers and uploads still go to the form's own link.
 */
export default async function ReadableFormPage(props: Props) {
  const view = await formAt(props);
  if (!view) notFound();
  return <HostedForm view={view} embed={(await props.searchParams).embed === "1"} />;
}
