import * as oauth from "oauth4webapi";
import { AmsError } from "./repository.js";
import {
  MailboxCredentialsSchema,
  MailboxVault,
  type MailboxCredentials,
} from "./mailbox-credentials.js";
import type { MailboxProvider } from "./mailbox-providers.js";

export const mailboxCallbackPath = (provider: MailboxProvider) =>
  `/api/mailbox/callback/${provider}`;
type ClientConfig = { clientId: string; clientSecret: string };
type Config = {
  origin: string;
  gmail?: ClientConfig;
  microsoft365?: ClientConfig & { tenant: string };
};
const scopes: Record<MailboxProvider, string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
  microsoft365: [
    "offline_access",
    "https://graph.microsoft.com/Mail.Read",
    "https://graph.microsoft.com/User.Read",
  ],
};
const reconnect = () =>
  new AmsError(
    409,
    "mailbox_reconnect_required",
    "Mailbox authorization is unavailable or expired. Reconnect and grant read access.",
  );

/** OAuth grants mailbox read access only; identity comes from the authenticated provider API. */
export class MailboxOAuth {
  constructor(
    private config: Config,
    private fetcher: typeof fetch = fetch,
    private now: () => Date = () => new Date(),
  ) {
    const origin = new URL(config.origin);
    if (
      origin.origin !== config.origin ||
      origin.username ||
      origin.password ||
      (origin.protocol !== "https:" &&
        !(
          origin.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
        ))
    )
      throw new Error(
        "Mailbox OAuth requires an HTTPS application origin, or loopback HTTP for local evaluation.",
      );
    if (
      config.microsoft365 &&
      !/^(organizations|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(
        config.microsoft365.tenant,
      )
    )
      throw new Error(
        "AMS_MAILBOX_MICROSOFT_TENANT_ID must be organizations or a directory UUID.",
      );
  }
  configured(provider: MailboxProvider) {
    return Boolean(this.config[provider]);
  }
  private metadata(provider: MailboxProvider) {
    const config = this.config[provider];
    if (!config)
      throw new AmsError(
        503,
        "mailbox_not_configured",
        "This mailbox provider has not been configured for this deployment.",
      );
    const base = `https://login.microsoftonline.com/${this.config.microsoft365?.tenant ?? "organizations"}`;
    const server: oauth.AuthorizationServer =
      provider === "gmail"
        ? {
            issuer: "https://accounts.google.com",
            authorization_endpoint:
              "https://accounts.google.com/o/oauth2/v2/auth",
            token_endpoint: "https://oauth2.googleapis.com/token",
          }
        : {
            issuer: `${base}/v2.0`,
            authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
            token_endpoint: `${base}/oauth2/v2.0/token`,
          };
    return {
      server,
      client: { client_id: config.clientId } satisfies oauth.Client,
      auth: oauth.ClientSecretPost(config.clientSecret),
      redirect: `${this.config.origin}${mailboxCallbackPath(provider)}`,
    };
  }
  async begin(provider: MailboxProvider) {
    const { server, client, redirect } = this.metadata(provider);
    const verifier = oauth.generateRandomCodeVerifier(),
      state = oauth.generateRandomState();
    const url = new URL(server.authorization_endpoint!);
    const params: Record<string, string> = {
      client_id: client.client_id,
      response_type: "code",
      redirect_uri: redirect,
      scope: scopes[provider].join(" "),
      state,
      code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      ...(provider === "gmail"
        ? {
            access_type: "offline",
            prompt: "consent",
            include_granted_scopes: "false",
          }
        : { response_mode: "query", prompt: "select_account" }),
    };
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    return { url: url.toString(), state, verifier };
  }
  private options(endpoint: string): oauth.TokenEndpointRequestOptions {
    return {
      signal: AbortSignal.timeout(15_000),
      [oauth.customFetch]: async (input, init) => {
        if (input !== endpoint) throw reconnect();
        const response = await this.fetcher(input, {
          ...init,
          redirect: "error",
        });
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          if (reader)
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 128 * 1024) {
                await reader.cancel();
                throw reconnect();
              }
              chunks.push(value);
            }
        } finally {
          reader?.releaseLock();
        }
        return new Response(Buffer.concat(chunks), {
          status: response.status,
          headers: response.headers,
        });
      },
    };
  }
  private credentials(
    provider: MailboxProvider,
    tokens: oauth.TokenEndpointResponse,
    previousRefresh?: string,
  ): MailboxCredentials {
    if (tokens.scope) {
      const granted = new Set(
        tokens.scope
          .split(" ")
          .map((s) =>
            s.replace(/^https:\/\/graph\.microsoft\.com\//, "").toLowerCase(),
          ),
      );
      const needed =
        provider === "gmail" ? [scopes.gmail[0]!] : ["mail.read", "user.read"];
      if (needed.some((s) => !granted.has(s))) throw reconnect();
    }
    if (
      !tokens.expires_in ||
      tokens.expires_in < 1 ||
      tokens.expires_in > 86_400
    )
      throw reconnect();
    const parsed = MailboxCredentialsSchema.safeParse({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || previousRefresh,
      expiresAt: new Date(
        this.now().getTime() + tokens.expires_in * 1000,
      ).toISOString(),
    });
    if (!parsed.success) throw reconnect();
    return parsed.data;
  }
  private safeError(error: unknown): never {
    // OAuth errors can include sensitive response bodies. They never reach logs or the UI.
    if (error instanceof AmsError) throw error;
    if (
      error instanceof oauth.ResponseBodyError &&
      [
        "invalid_grant",
        "access_denied",
        "interaction_required",
        "consent_required",
      ].includes(error.error)
    )
      throw reconnect();
    throw new AmsError(
      502,
      "mailbox_authorization_failed",
      "The mailbox provider could not complete authorization. Check the provider configuration and try connecting again.",
    );
  }
  async exchange(
    provider: MailboxProvider,
    callback: URLSearchParams,
    state: string,
    verifier: string,
  ) {
    const { server, client, auth, redirect } = this.metadata(provider);
    try {
      const parameters = oauth.validateAuthResponse(
        server,
        client,
        callback,
        state,
      );
      const response = await oauth.authorizationCodeGrantRequest(
        server,
        client,
        auth,
        parameters,
        redirect,
        verifier,
        this.options(server.token_endpoint!),
      );
      return this.credentials(
        provider,
        await oauth.processAuthorizationCodeResponse(server, client, response),
      );
    } catch (error) {
      return this.safeError(error);
    }
  }
  async refresh(provider: MailboxProvider, credentials: MailboxCredentials) {
    const { server, client, auth } = this.metadata(provider);
    try {
      const response = await oauth.refreshTokenGrantRequest(
        server,
        client,
        auth,
        credentials.refreshToken,
        {
          ...this.options(server.token_endpoint!),
          additionalParameters: { scope: scopes[provider].join(" ") },
        },
      );
      return this.credentials(
        provider,
        await oauth.processRefreshTokenResponse(server, client, response),
        credentials.refreshToken,
      );
    } catch (error) {
      return this.safeError(error);
    }
  }
}

export function mailboxRuntime(env: NodeJS.ProcessEnv = process.env) {
  const googleId = env.AMS_MAILBOX_GOOGLE_CLIENT_ID,
    googleSecret = env.AMS_MAILBOX_GOOGLE_CLIENT_SECRET;
  const microsoftId = env.AMS_MAILBOX_MICROSOFT_CLIENT_ID,
    microsoftSecret = env.AMS_MAILBOX_MICROSOFT_CLIENT_SECRET;
  const configured = Boolean(
    googleId || googleSecret || microsoftId || microsoftSecret,
  );
  const vault = env.AMS_MAILBOX_ENCRYPTION_KEY
    ? new MailboxVault(env.AMS_MAILBOX_ENCRYPTION_KEY)
    : undefined;
  if (!configured) return { vault, oauth: undefined };
  if (
    Boolean(googleId) !== Boolean(googleSecret) ||
    Boolean(microsoftId) !== Boolean(microsoftSecret)
  )
    throw new Error(
      "Mailbox provider configuration requires both its client ID and client secret.",
    );
  if (!vault)
    throw new Error(
      "Configured mailbox providers require AMS_MAILBOX_ENCRYPTION_KEY.",
    );
  const origin = env.AMS_APP_URL || env.NEXT_PUBLIC_APP_URL;
  if (!origin)
    throw new Error(
      "Configured mailbox providers require AMS_APP_URL with the registered application origin.",
    );
  const auth = new MailboxOAuth({
    origin,
    ...(googleId && googleSecret
      ? { gmail: { clientId: googleId, clientSecret: googleSecret } }
      : {}),
    ...(microsoftId && microsoftSecret
      ? {
          microsoft365: {
            clientId: microsoftId,
            clientSecret: microsoftSecret,
            tenant: env.AMS_MAILBOX_MICROSOFT_TENANT_ID || "organizations",
          },
        }
      : {}),
  });
  return { vault, oauth: auth };
}
