// The lexicon Worker's databases in workerd (wrangler's test harness), and its app on them.
import { after, before, beforeEach } from "node:test";
import { hc } from "hono/client";
import { createTestHarness, type TestHarness } from "wrangler";
import { LANGS } from "@skolia/shared/api";
import { createApp, type AppType } from "../app.ts";
import { D1Lexicon } from "../store.ts";
import { clearLexicons, lexiconBinding, lexiconsOf, type LexiconBindings } from "./load.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

export let server: TestHarness;
export let env: LexiconBindings;

export function useLocal(): void {
  before(async () => {
    server = createTestHarness({ root: ROOT, workers: [{ configPath: "./wrangler.jsonc", env: "" }] });
    await server.listen();
    const worker = server.getWorker<LexiconBindings>();
    for (const lang of LANGS) await worker.applyD1Migrations(lexiconBinding(lang));
    env = await worker.getEnv();
  });
  beforeEach(() => clearLexicons(env));
  after(() => server?.close());
}

/** The app on the local databases, each response checked against the spec. */
export function setup() {
  return createApp({ lexicon: new D1Lexicon(lexiconsOf(env), "first-primary"), checkResponses: true });
}

/** The typed client (hono/client), sending to the app. */
export function client(app: ReturnType<typeof setup>, headers: Record<string, string> = {}) {
  return hc<AppType>("http://lexicon.test", {
    fetch: (input: string | URL | Request, init?: RequestInit) => app.request(input, init),
    headers,
  }).v1;
}
