// skolia-oauth-proxy on Cloudflare Workers (wrangler.jsonc): the previews' Google sign-in
// (handler.ts). Deployed from main by just deploy-oauth-proxy.
import { oauthProxyHandler } from "./handler.ts";

interface Env {
  /** wrangler vars */
  BASE_URL: string;
  PREVIEWS: string;
  /** Secrets: the skolia-preview Google client, and the secret the previews share */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  OAUTH_PROXY_SECRET: string;
}

export default {
  fetch(request, env) {
    return oauthProxyHandler({
      baseURL: env.BASE_URL,
      secret: env.OAUTH_PROXY_SECRET,
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
      previews: new RegExp(env.PREVIEWS),
    })(request);
  },
} satisfies ExportedHandler<Env>;
