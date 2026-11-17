// Per-deployment settings for the Firebase mode, read from the runtime environment.
// Each is optional and, when unset, keeps the one-deployment-per-project behaviour
// (default Firestore database, project-level Firebase Auth, NEXT_PUBLIC_APP_URL). They
// let several isolated deployments share one Google Cloud project and one container
// image (docs/cloud-run.md).

type Env = Record<string, string | undefined>;

/**
 * The public origin users sign in at. AMS_APP_URL (runtime) wins over
 * NEXT_PUBLIC_APP_URL, which App Hosting deployments set for build and runtime.
 */
export function configuredAppUrl(env: Env = process.env): string | undefined {
  return env.AMS_APP_URL?.trim() || env.NEXT_PUBLIC_APP_URL?.trim() || undefined;
}

/** The origin of {@link configuredAppUrl}, or undefined when unset. Throws if invalid. */
export function configuredAppOrigin(env: Env = process.env): string | undefined {
  const value = configuredAppUrl(env);
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("AMS_APP_URL / NEXT_PUBLIC_APP_URL is not a valid URL.");
  }
  return url.origin;
}

// Firestore database ids: 4-63 characters, lowercase letters, digits and hyphens,
// starting with a letter and not ending with a hyphen. "(default)" is the default one.
const DATABASE_ID = /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/;

/** A named Firestore database (AMS_FIRESTORE_DATABASE), or undefined for the default. */
export function firestoreDatabaseId(env: Env = process.env): string | undefined {
  const value = env.AMS_FIRESTORE_DATABASE?.trim();
  if (!value || value === "(default)") return undefined;
  if (!DATABASE_ID.test(value))
    throw new Error(
      "AMS_FIRESTORE_DATABASE must be a Firestore database id (lowercase letters, digits and hyphens, 4-63 characters).",
    );
  return value;
}

// Identity Platform tenant ids are generated from the display name, e.g. "agency-a-1x2y3".
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/** An Identity Platform tenant (AMS_AUTH_TENANT_ID), or undefined for project-level Auth. */
export function authTenantId(env: Env = process.env): string | undefined {
  const value = env.AMS_AUTH_TENANT_ID?.trim();
  if (!value) return undefined;
  if (!TENANT_ID.test(value))
    throw new Error("AMS_AUTH_TENANT_ID must be an Identity Platform tenant id.");
  return value;
}
