import type { AmsPublicAgencyForms } from "@openams/contracts";

/** Where a form is linked from its agency's page: its readable address, or its own link
 *  when another live form has the same readable name. */
export function agencyFormHref(agency: Pick<AmsPublicAgencyForms, "handle" | "forms">, linkId: string) {
  const form = agency.forms.find((item) => item.linkId === linkId);
  const shared = form && agency.forms.some((item) => item.linkId !== linkId && item.path === form.path);
  return form && !shared ? `/f/${agency.handle}/${form.path}` : `/f/${linkId}`;
}
