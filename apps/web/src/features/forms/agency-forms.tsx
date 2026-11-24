import { ArrowRight, Lock, Mail, Phone } from "lucide-react";
import { amsFormStored } from "@openams/contracts";
import type { AmsPublicAgencyForms } from "@openams/contracts";
import { agencyFormHref } from "./form-address-model";
import { inkOn } from "./form-color";
import { LineIcon } from "./line-icons";
import "./form-runner.css";
import "./agency-forms.css";

/** An agency's live forms at its forms address (/f/<handle>): one card per form. */
export function AgencyForms({ agency }: { agency: AmsPublicAgencyForms }) {
  const accent = /^#[0-9a-f]{6}$/i.test(agency.accent) ? agency.accent : "#1f6f5c";
  const reach = (agency.phone || agency.email) && (
    <span className="hf-reach">
      {agency.phone && (
        <a href={`tel:${agency.phone.replace(/[^0-9+]/g, "")}`}>
          <Phone size={14} aria-hidden="true" />
          {/^1?\d{10}$/.test(agency.phone.replace(/\D/g, ""))
            ? amsFormStored("phone", agency.phone)
            : agency.phone}
        </a>
      )}
      {agency.email && (
        <a href={`mailto:${agency.email}`}>
          <Mail size={14} aria-hidden="true" />
          {agency.email}
        </a>
      )}
    </span>
  );
  return (
    <div
      className="hf"
      style={{ "--hf-accent": accent, "--hf-on-accent": inkOn(accent) } as React.CSSProperties}
    >
      <header className="hf-top">
        <div className="hf-brand">
          {agency.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={agency.logo} alt="" />
          ) : (
            <span className="hf-monogram" aria-hidden="true">
              {agency.name.trim().charAt(0).toUpperCase()}
            </span>
          )}
          <strong>{agency.name}</strong>
        </div>
        {reach}
      </header>
      <main className="hf-main">
        <section className="hf-card af">
          <p className="hf-eyebrow">{agency.name}</p>
          <h1>How can we help?</h1>
          {agency.forms.length ? (
            <>
              <p className="hf-intro">
                {agency.forms.length === 1
                  ? "Answer a few questions and we'll take it from there."
                  : "Choose a form to get started."}
              </p>
              <ul className="af-forms">
                {agency.forms.map((form) => (
                  <li key={form.linkId}>
                    <a href={agencyFormHref(agency, form.linkId)}>
                      <span className="af-text">
                        <strong>{form.title}</strong>
                        {form.intro && <span className="af-intro">{form.intro}</span>}
                      </span>
                      {form.lines.length > 0 && (
                        <span className="af-lines">
                          {form.lines.map((line) => (
                            <span key={line.id}>
                              <LineIcon line={line.id} size={15} />
                              {line.label}
                            </span>
                          ))}
                        </span>
                      )}
                      <span className="af-go" aria-hidden="true">
                        <ArrowRight size={18} />
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <p className="hf-intro">
                {agency.name} has no forms open right now. Reach the agency directly and they
                will help you.
              </p>
              {reach}
            </>
          )}
        </section>
      </main>
      <footer className="hf-foot">
        <span>
          <Lock size={12} aria-hidden="true" />
          Your answers go to {agency.name}. Never enter passwords or card numbers here.
        </span>
        <a href="https://openams.com" target="_blank" rel="noreferrer">
          Powered by OpenAMS
        </a>
      </footer>
    </div>
  );
}
