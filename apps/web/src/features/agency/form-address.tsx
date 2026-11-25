"use client";

import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { amsFormHandleError, amsFormPath } from "@openams/contracts";
import { AgencyRequestError, request } from "./model";
import "./form-address.css";

/*
 * The agency's forms address for the builder's Share step: one address, chosen once,
 * that lists the agency's live forms at /f/<handle> and gives each form a readable link
 * at /f/<handle>/<form>.
 */

type AddressState = { handle: string | null; suggestion: string; publishing: boolean };

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="agency-button"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        })
      }
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
function LinkRow({ label, url }: { label: string; url: string }) {
  return (
    <div className="fa-row">
      <span className="fa-label">{label}</span>
      <code>{url}</code>
      <CopyButton text={url} />
      <a className="agency-button" href={url} target="_blank" rel="noreferrer">
        <ExternalLink size={15} />
        Open
      </a>
    </div>
  );
}

export function FormAddress({ origin, linkId }: { origin: string; linkId: string | null }) {
  const [state, setState] = useState<AddressState | null>(null);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState("");

  useEffect(() => {
    let current = true;
    request<AddressState>("forms/address")
      .then((loaded) => {
        if (!current || typeof loaded?.publishing !== "boolean") return;
        setState(loaded);
        setValue(loaded.suggestion || "");
      })
      // No address route on this deployment, or it can't be read: show nothing.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  if (!state || !state.publishing) return null;

  if (state.handle) {
    const agencyUrl = `${origin}/f/${state.handle}`;
    return (
      <section className="fa" aria-label="Your forms address">
        <LinkRow label="Your forms page" url={agencyUrl} />
        {linkId && <LinkRow label="This form" url={`${agencyUrl}/${amsFormPath(linkId)}`} />}
      </section>
    );
  }

  const problem = amsFormHandleError(value);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving || problem) return;
    setSaving(true);
    setRefusal("");
    try {
      const result = await request<{ handle: string }>("forms/address", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: value }),
      });
      setState((previous) => previous && { ...previous, handle: result.handle });
    } catch (failure) {
      const code = failure instanceof AgencyRequestError ? failure.code : "";
      if (code === "handle_set") {
        // Someone at the agency set it first. Read what it is now.
        const now = await request<AddressState>("forms/address").catch(() => null);
        if (now?.handle) setState(now);
        else setRefusal("Your agency already has a forms address. Reload the page to see it.");
      } else if (code === "handle_taken") setRefusal("That address is taken. Try another.");
      else setRefusal(failure instanceof Error ? failure.message : "The address could not be set.");
    } finally {
      setSaving(false);
    }
  }
  const shown = refusal || (value && problem) || "";
  return (
    <form className="fa" onSubmit={(event) => void submit(event)}>
      <div className="fa-row">
        <label className="fa-label" htmlFor="fa-handle">
          Your forms address
        </label>
        <span className="fa-field" data-invalid={shown ? true : undefined}>
          <span aria-hidden="true">{origin.replace(/^https?:\/\//, "")}/f/</span>
          <input
            id="fa-handle"
            value={value}
            maxLength={64}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            aria-invalid={shown ? true : undefined}
            aria-describedby="fa-note"
            onChange={(event) => {
              setValue(event.target.value.toLowerCase().replace(/\s+/g, "-"));
              setRefusal("");
            }}
          />
        </span>
        <button type="submit" className="agency-button primary" disabled={saving || Boolean(problem)}>
          {saving ? "Setting…" : "Set address"}
        </button>
      </div>
      <p id="fa-note" className="fa-note" role={shown ? "alert" : undefined} data-problem={shown ? true : undefined}>
        {shown || "One page for all your live forms. It can't be changed later."}
      </p>
    </form>
  );
}
