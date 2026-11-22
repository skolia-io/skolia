// skolia-api on Cloudflare Workers (api/wrangler.jsonc). Static assets (the reader) are
// served before the Worker runs, except for /api/*. /api/lexicon/* is the lexicon
// Worker's API (lexicon/src/app.ts), passed through, so the reader reads it on its own
// origin in every environment, previews included.
import { createApp } from "../app.ts";
import { BACKGROUND_MIGRATIONS } from "./background-migrations/index.ts";
import { runBackgroundMigrations } from "./background-migrations/runner.ts";
import { NO_AUTH, createAuth } from "../auth.ts";
import type { IngesterRpc, IngestParams } from "@skolia/ingest/rpc";
import { log } from "@skolia/util/log";
import type { Auth } from "../ports/auth.ts";
import { RpcIngestHistory, IngestRuns } from "./adapters/ingest.ts";
import { D1Documents } from "./adapters/documents.ts";
import type { LexiconRpc } from "@skolia/lexicon/rpc";
import { RpcLexicon } from "./adapters/lexicon.ts";
import { DurableObjectUsers } from "./adapters/users.ts";
import { readerConfig } from "../reader-config.ts";
import { importRate } from "../rate-limits.ts";
import { D1Permissions } from "./adapters/permissions.ts";
import { R2Blobs } from "./adapters/blobs.ts";
import type { User } from "./user.ts";

export { User } from "./user.ts";

const logger = log("api");

/** Where the lexicon Worker's API is, here */
const LEXICON_PATH = "/api/lexicon";

interface Env {
  DB: D1Database;
  /** The lexicon Worker (lexicon/wrangler.jsonc): its LexiconService, and its API */
  LEXICON: Service<LexiconRpc>;
  USER: DurableObjectNamespace<User>;
  BLOBS: R2Bucket;
  /** The ingest Worker's runs of ingest, one per document and version */
  INGEST_WORKFLOW: Workflow<IngestParams>;
  /** The ingest Worker's queue state and history */
  INGESTER: DurableObjectNamespace<IngesterRpc>;
  /** wrangler vars (api/wrangler.jsonc); a preview's from infra/preview.py */
  BASE_URL?: string;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** A preview's (infra/preview.py): the OAuth proxy's URL (oauth-proxy/), where its Google sign-in goes */
  OAUTH_PROXY_URL?: string;
  OAUTH_PROXY_SECRET?: string;
  /** infra/plan.py version, a var (just deploy-web) rather than in the bundle, so the bundle's
   * Nix out path doesn't change with it; unset under wrangler dev */
  VERSION?: string;
  /** How many lexicon entries the reader fetches at once (reader-config.ts) */
  READER_LEXICON_CONCURRENCY?: string;
  /** How many imports a user may make in a window, and the window's length (rate-limits.ts) */
  IMPORT_RATE_LIMIT?: string;
  IMPORT_RATE_WINDOW_SECONDS?: string;
}

/** A Better Auth instance per request: it sets itself up on first use and keeps that
 * promise, and a request that awaits a promise made in another can hang on Workers (in
 * pr-16's smoke tests, one of two concurrent first requests got no response). */
let warned = false;

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  logger.warn(message);
}

function authFor(env: Env): Auth {
  const { BASE_URL, BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_PROXY_URL, OAUTH_PROXY_SECRET } = env;
  if (!BASE_URL || !BETTER_AUTH_SECRET) {
    warnOnce("BASE_URL or BETTER_AUTH_SECRET isn't set; sign-in is off");
    return NO_AUTH;
  }
  const google = GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET ? { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET } : undefined;
  if (!google) warnOnce("GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET isn't set; only API keys sign in");
  const oauthProxy = OAUTH_PROXY_URL && OAUTH_PROXY_SECRET ? { url: OAUTH_PROXY_URL, secret: OAUTH_PROXY_SECRET } : undefined;
  return createAuth({ database: env.DB, baseURL: BASE_URL, secret: BETTER_AUTH_SECRET, google, oauthProxy });
}

export default {
  async scheduled(_event, env) {
    await runBackgroundMigrations({ db: env.DB.withSession("first-primary"), blobs: new R2Blobs(env.BLOBS) }, BACKGROUND_MIGRATIONS);
  },
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(`${LEXICON_PATH}/`)) {
      url.pathname = url.pathname.slice(LEXICON_PATH.length);
      return env.LEXICON.fetch(new Request(url, request));
    }
    const app = createApp({
      auth: authFor(env),
      users: new DurableObjectUsers(env.USER),
      lexicon: new RpcLexicon(env.LEXICON),
      version: env.VERSION ?? "dev",
      reader: readerConfig(env),
      importRate: importRate(env),
      permissions: new D1Permissions(env.DB),
      documents: new D1Documents(env.DB.withSession("first-primary")),
      blobs: new R2Blobs(env.BLOBS),
      queue: new IngestRuns(env.INGEST_WORKFLOW, (lang) => env.INGESTER.getByName(lang).jobs(lang)),
      ingestHistory: new RpcIngestHistory(env.INGESTER),
      now: () => new Date(),
    });
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
