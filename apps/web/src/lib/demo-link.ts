/**
 * The public demo's way onward: one link in the demo banner, for example to the page
 * where a visitor can get OpenAMS for their own agency. Optional; unset shows no link.
 *   AMS_DEMO_LINK_URL    an https address (http only for localhost)
 *   AMS_DEMO_LINK_LABEL  up to 40 characters; "Get OpenAMS for your agency" by default
 */
export function demoLink(env: Record<string, string | undefined> = process.env) {
  let url: URL;
  try {
    url = new URL(env.AMS_DEMO_LINK_URL ?? "");
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password) return null;
  const label = (env.AMS_DEMO_LINK_LABEL ?? "").replace(/\s+/g, " ").trim();
  return {
    url: url.toString(),
    label: label && label.length <= 40 ? label : "Get OpenAMS for your agency",
  };
}
