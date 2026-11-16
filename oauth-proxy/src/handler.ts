import { betterAuth } from "better-auth";
import { oAuthProxy } from "better-auth/plugins/oauth-proxy";

export type OAuthProxyConfig = {
  /** Its own URL, whose /api/auth/callback/google is the Google client's redirect URI */
  readonly baseURL: string;
  /** Shared with the previews (api/src/auth.ts, AuthConfig.oauthProxy) */
  readonly secret: string;
  readonly google: { readonly clientId: string; readonly clientSecret: string };
  /** The origins it hands a profile to */
  readonly previews: RegExp;
};

export const CALLBACK_PATH = "/api/auth/callback/google";

/** Google's redirect for the previews' sign-in, which Google can't send to each preview's
 * own host. Better Auth's oAuthProxy plugin: a preview puts its state in Google's, encrypted
 * with the shared secret; this exchanges the code with Google and redirects to the preview
 * with the profile, encrypted too, and the preview makes the user and session. It keeps
 * nothing, so it has no database, and it answers only the callback, and only with a
 * redirect to a preview. */
export function oauthProxyHandler(config: OAuthProxyConfig): (request: Request) => Promise<Response> {
  const auth = betterAuth({
    baseURL: config.baseURL,
    secret: config.secret,
    socialProviders: { google: config.google },
    plugins: [oAuthProxy({ productionURL: config.baseURL, secret: config.secret })],
    telemetry: { enabled: false },
  });
  return async (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) return new Response("Not Found", { status: 404 });
    const response = await auth.handler(request);
    const location = response.headers.get("location");
    const to = location ? new URL(location, url) : null;
    if (response.status === 302 && to && config.previews.test(to.origin)) return response;
    // Not a preview's sign-in, or Google's error, which goes to the proxy's own error page
    const error = to?.searchParams.get("error");
    return new Response(`Sign-in failed${error ? `: ${error}` : ""}`, { status: 400 });
  };
}
