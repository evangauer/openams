import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Mail, Phone } from "lucide-react";
import { FormRunner } from "@/features/forms/form-runner";
import { inkOn } from "@/features/forms/form-color";
import { loadPublicForm } from "@/lib/server/public-forms";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ link: string }>;
  searchParams: Promise<{ embed?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const view = await loadPublicForm((await params).link);
  if (!view) return { title: "Form not found", robots: { index: false } };
  const agency = view.status === "open" ? view.form.branding.agencyName : view.branding.agencyName;
  const title = view.status === "open" ? view.form.title : view.title;
  return {
    title: `${title} · ${agency}`,
    description: view.status === "open" ? view.form.intro || undefined : undefined,
    // An agency shares its link itself; a form doesn't belong in search results.
    robots: { index: false, follow: false },
  };
}

/** A hosted form at its public link. Anyone with the link can open it; no one signs in. */
export default async function HostedFormPage({ params, searchParams }: Props) {
  const view = await loadPublicForm((await params).link);
  if (!view) notFound();
  const embed = (await searchParams).embed === "1";
  // Inside an agency's own page the form sits on that page's background.
  const frameStyle = embed ? <style>{"html,body{background:transparent}"}</style> : null;
  if (view.status === "open")
    return (
      <>
        {frameStyle}
        <FormRunner form={view.form} embed={embed} />
      </>
    );
  const { branding } = view;
  return (
    <div
      className="hf"
      data-embed={embed || undefined}
      style={
        {
          "--hf-accent": branding.accent,
          "--hf-on-accent": inkOn(branding.accent),
        } as React.CSSProperties
      }
    >
      {frameStyle}
      <header className="hf-top">
        <div className="hf-brand">
          {branding.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={branding.logo} alt="" />
          ) : (
            <span className="hf-monogram" aria-hidden="true">
              {branding.agencyName.trim().charAt(0).toUpperCase()}
            </span>
          )}
          <strong>{branding.agencyName}</strong>
        </div>
      </header>
      <main className="hf-main">
        <section className="hf-card hf-done">
          <h1>This form is closed for now</h1>
          <p>
            {branding.agencyName} isn&apos;t taking responses through this form right now.
            Reach the agency directly and they will help you.
          </p>
          {(branding.phone || branding.email) && (
            <span className="hf-reach">
              {branding.phone && (
                <a href={`tel:${branding.phone.replace(/[^0-9+]/g, "")}`}>
                  <Phone size={14} aria-hidden="true" />
                  {branding.phone}
                </a>
              )}
              {branding.email && (
                <a href={`mailto:${branding.email}`}>
                  <Mail size={14} aria-hidden="true" />
                  {branding.email}
                </a>
              )}
            </span>
          )}
        </section>
      </main>
    </div>
  );
}
