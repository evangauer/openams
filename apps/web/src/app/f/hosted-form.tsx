import type { Metadata } from "next";
import { Mail, Phone } from "lucide-react";
import { FormRunner } from "@/features/forms/form-runner";
import { inkOn } from "@/features/forms/form-color";
import type { PublicFormView } from "@/lib/server/public-forms";

/* What a hosted form's page shows, shared by its two addresses: /f/<link> and the
 * readable /f/<agency>/<form>. Both resolve to one link; this renders what it opens. */

export function hostedFormMetadata(view: PublicFormView | null): Metadata {
  if (!view) return { title: "Form not found", robots: { index: false } };
  if (view.status === "unavailable")
    return { title: "Form temporarily unavailable", robots: { index: false } };
  const agency = view.status === "open" ? view.form.branding.agencyName : view.branding.agencyName;
  const title = view.status === "open" ? view.form.title : view.title;
  return {
    title: `${title} · ${agency}`,
    description: view.status === "open" ? view.form.intro || undefined : undefined,
    // An agency shares its link itself; a form doesn't belong in search results.
    robots: { index: false, follow: false },
  };
}

export function HostedForm({ view, embed }: { view: PublicFormView; embed: boolean }) {
  // Inside an agency's own page the form sits on that page's background.
  const frameStyle = embed ? <style>{"html,body{background:transparent}"}</style> : null;
  if (view.status === "unavailable")
    return (
      <div className="hf" data-embed={embed || undefined}>
        {frameStyle}
        <main className="hf-main" style={{ paddingTop: 72 }}>
          <section className="hf-card hf-done">
            <h1>This form can&apos;t be opened right now</h1>
            <p>
              Your link is fine. Give it a minute and reload the page, or reach the agency
              directly.
            </p>
          </section>
        </main>
      </div>
    );
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
