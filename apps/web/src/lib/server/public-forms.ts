import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import type { AmsForm, AmsPublicForm } from "@openams/contracts";
import {
  firebaseApiUrl,
  firebaseAuthMode,
  localAmsEnabled,
  localAmsRequestAllowed,
} from "./ams-context";
import { clientAddressHeaders } from "./client-address";

/*
 * Public form pages and their two endpoints. They never read a session cookie: a visitor
 * is whoever holds the link, and the API decides what the link opens.
 */

export const FORM_LINK = /^[a-z0-9](?:[a-z0-9-]{4,62})[a-z0-9]$/;
export type PublicFormView =
  | { status: "open"; form: AmsPublicForm }
  | { status: "closed"; title: string; branding: AmsForm["branding"] };

/** The API address for public form requests, or null where this deployment can't serve them. */
export async function publicFormsApi(request: Request): Promise<string | null> {
  if (firebaseAuthMode()) return firebaseApiUrl();
  // Local evaluation keeps its own rule: loopback only (or the preview's sign-in).
  if (!localAmsEnabled() || !(await localAmsRequestAllowed(request))) return null;
  return process.env.AMS_LOCAL_API_URL || null;
}
/** Headers for a forwarded public request: who the client is, and nothing they sent. */
export const publicFormHeaders = (request: Request): Record<string, string> => ({
  Accept: "application/json",
  ...clientAddressHeaders(request),
});

/** The form behind a link, for the page. Null: the link leads nowhere. */
export const loadPublicForm = cache(async (link: string): Promise<PublicFormView | null> => {
  if (!FORM_LINK.test(link)) return null;
  const incoming = await headers();
  const host = incoming.get("host") || "localhost";
  const request = new Request(`http://${host}/f/${link}`, { headers: incoming });
  const api = await publicFormsApi(request);
  if (!api) return null;
  const response = await fetch(`${api}/public/forms/${link}`, {
    headers: publicFormHeaders(request),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response?.ok) return null;
  return (await response.json()) as PublicFormView;
});
