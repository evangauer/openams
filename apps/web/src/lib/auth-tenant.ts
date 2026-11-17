// The Identity Platform tenant a deployment signs people in through (AMS_AUTH_TENANT_ID).
// It is a runtime setting so one container image can serve several deployments: the root
// layout (a server component, rendered per request) writes it into a <meta> tag and the
// browser's Firebase client reads it back before any sign-in call. Unset means
// project-level Firebase Auth, as before. A tenant id is not a secret.

export const AUTH_TENANT_META = "openams-auth-tenant";

const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/** Server side: the configured tenant id, or null when unset or malformed. */
export function runtimeAuthTenantId(
  value: string | undefined = process.env.AMS_AUTH_TENANT_ID,
): string | null {
  const tenant = value?.trim();
  return tenant && TENANT_ID.test(tenant) ? tenant : null;
}

/** Browser side: the tenant id the layout published, or null for project-level Auth. */
export function documentAuthTenantId(
  doc: Pick<Document, "querySelector"> | undefined = typeof document === "undefined"
    ? undefined
    : document,
): string | null {
  const content = doc
    ?.querySelector(`meta[name="${AUTH_TENANT_META}"]`)
    ?.getAttribute("content");
  return runtimeAuthTenantId(content ?? undefined);
}
