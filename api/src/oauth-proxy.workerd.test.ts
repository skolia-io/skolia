import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createAuth } from "./auth.ts";
import { CALLBACK_PATH, oauthProxyHandler } from "./oauth-proxy.ts";
import { local, useLocal } from "./testing/app.ts";
import { authConfig } from "./testing/harness.ts";

useLocal();

const PROXY = "https://oauth-proxy.example";
const SECRET = "the shared proxy secret, at least 32 characters";
const google = { clientId: "preview-id", clientSecret: "preview-secret" };
const proxy = oauthProxyHandler({ baseURL: PROXY, secret: SECRET, google, previews: /^https:\/\/pr-[0-9]+\.example$/ });
const CLAIMS = { sub: "google-1", email: "bob@example.com", email_verified: true, name: "Bob" };

function previewAt(origin: string) {
  return createAuth({
    ...authConfig(local.env.DB),
    baseURL: origin,
    secret: `${origin}'s own secret, at least 32 characters`,
    google,
    oauthProxy: { url: PROXY, secret: SECRET },
  });
}

/** Google's answer to the proxy's code exchange */
function fakeGoogle(t: TestContext): void {
  const idToken = [{ alg: "none" }, CLAIMS, {}].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    new Request(input).url === "https://oauth2.googleapis.com/token"
      ? Promise.resolve(Response.json({ access_token: "access", id_token: idToken, token_type: "Bearer", expires_in: 3600 }))
      : realFetch(input, init),
  );
}

/** Google sign-in on the preview: the authorize URL it answers with */
async function signIn(preview: ReturnType<typeof previewAt>, origin: string, page: string): Promise<URL> {
  const response = await preview.handle(
    new Request(`${origin}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ provider: "google", callbackURL: page }),
    }),
  );
  assert.equal(response.status, 200);
  return new URL(((await response.json()) as { url: string }).url);
}

/** Google's redirect back to the proxy */
function callback(authorize: URL): Promise<Response> {
  const state = authorize.searchParams.get("state") ?? "";
  return proxy(new Request(`${PROXY}${CALLBACK_PATH}?${new URLSearchParams({ state, code: "a code" })}`));
}

test("a preview signs in with Google through the proxy, and the session is the preview's", async (t) => {
  const origin = "https://pr-1.example";
  const preview = previewAt(origin);
  const page = `${origin}/read/1`;
  const authorize = await signIn(preview, origin, page);
  assert.equal(authorize.searchParams.get("redirect_uri"), `${PROXY}${CALLBACK_PATH}`);
  assert.equal(authorize.searchParams.get("client_id"), google.clientId);

  fakeGoogle(t);
  const proxied = await callback(authorize);
  assert.equal(proxied.status, 302);
  const location = new URL(proxied.headers.get("location") ?? "");
  assert.equal(`${location.origin}${location.pathname}`, `${origin}/api/auth/callback/google/oauth-proxy`);

  const completion = await preview.handle(new Request(location));
  assert.equal(completion.status, 302);
  assert.equal(completion.headers.get("location"), page);
  const cookie = completion.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert.equal((await preview.user(new Headers({ cookie })))?.email, CLAIMS.email);
  assert.equal(await previewAt("https://pr-2.example").user(new Headers({ cookie })), null);
});

test("the proxy doesn't hand a profile to an origin that isn't a preview's", async (t) => {
  const origin = "https://elsewhere.example";
  const authorize = await signIn(previewAt(origin), origin, `${origin}/`);
  fakeGoogle(t);
  const response = await callback(authorize);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("location"), null);
});

test("the proxy answers only Google's callback, and only with a state a preview made", async () => {
  for (const path of ["/api/auth/sign-in/social", "/api/auth/callback/google/oauth-proxy", "/api/auth/get-session", "/"]) {
    assert.equal((await proxy(new Request(`${PROXY}${path}`))).status, 404, path);
  }
  const forged = await proxy(new Request(`${PROXY}${CALLBACK_PATH}?state=forged&code=a+code`));
  assert.equal(forged.status, 400);
  const cancelled = await proxy(new Request(`${PROXY}${CALLBACK_PATH}?state=forged&error=access_denied`));
  assert.equal(cancelled.status, 400);
});
