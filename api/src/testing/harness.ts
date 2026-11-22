import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { createTestHarness, type TestHarness } from "wrangler";
import { LANGS, type Identity } from "@skolia/shared/api";
import { UserId } from "@skolia/shared/schemas";
import type { IngestParams } from "@skolia/ingest/rpc";
import { authOptions, toAuth, type AuthConfig } from "../auth.ts";
import type { Auth } from "../ports/auth.ts";
import { sql } from "@skolia/util/sql";
import type { LexiconRpc } from "@skolia/lexicon/rpc";
import { clearLexicons, lexiconBinding, type LexiconBindings } from "@skolia/lexicon/testing";
import { prepare } from "@skolia/util/d1";
import type { User as UserObject } from "../worker/user.ts";
import type { RecorderEnv } from "./ingest-recorder.ts";
import { SYSTEM_USER } from "../e2e-keys.ts";
import { CURATED_USER } from "../sync-curated-key.ts";

export const ORIGIN = "http://localhost:5173";

const API = new URL("../../", import.meta.url).pathname;
const DIST = `${API}dist/`;

export interface TestEnv {
  DB: D1Database;
  LEXICON: Service<LexiconRpc>;
  USER: DurableObjectNamespace<UserObject>;
  BLOBS: R2Bucket;
  INGEST_WORKFLOW: Workflow<IngestParams>;
}

export function authConfig(database: D1Database): AuthConfig {
  return {
    database,
    baseURL: ORIGIN,
    secret: "a test secret that is at least 32 characters",
    google: { clientId: "id", clientSecret: "secret" },
    oauthProxy: undefined,
  };
}

export interface Local {
  server: TestHarness;
  env: TestEnv & RecorderEnv;
  /** The lexicon Worker's databases, which the API's LEXICON reads */
  lexicon: LexiconBindings;
  auth: Auth;
  /** A new user, bound to no roles. */
  signUp(fields: { name: string; email: string }): Promise<Identity>;
  signIn(userId: string): Promise<Headers>;
  /** What the API has asked to start runs of ingest for (testing/app.ts setup) */
  readonly started: IngestParams[];
  takeQueued(): Promise<IngestParams[]>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function startLocal(): Promise<Local> {
  assert.ok(existsSync(`${DIST}main.js`), "api/dist/main.js is missing: just build first");
  const server = createTestHarness({
    root: API,
    workers: [
      { configPath: "./wrangler.jsonc", env: "dev", prebuiltWorkerDir: DIST, vars: { MUTABLE_FINAL_USER_MIGRATION: "true" } },
      { configPath: "./src/testing/ingest-recorder.jsonc" },
      { configPath: "./wrangler.internal.jsonc", env: "dev" },
      { configPath: "../lexicon-api/wrangler.jsonc", env: "dev" },
    ],
  });
  await server.listen();
  const worker = server.getWorker<TestEnv>();
  await worker.applyD1Migrations("DB");
  const lexiconWorker = server.getWorker<LexiconBindings>("skolia-lexicon");
  for (const lang of LANGS) await lexiconWorker.applyD1Migrations(lexiconBinding(lang));
  const lexicon = await lexiconWorker.getEnv();
  const ingest = server.getWorker<RecorderEnv>("skolia-ingest");
  await ingest.applyD1Migrations("INGEST_DB");
  const { INGEST_DB, DOCUMENT_STATUS } = await ingest.getEnv();
  const env = { ...(await worker.getEnv()), INGEST_DB, DOCUMENT_STATUS };
  const options = authOptions(authConfig(env.DB));
  const instance = betterAuth({ ...options, plugins: [...options.plugins, testUtils()] });
  const { test } = await instance.$context;
  const started: IngestParams[] = [];

  async function takeQueued(): Promise<IngestParams[]> {
    return started.splice(0);
  }

  return {
    server,
    env,
    lexicon,
    auth: toAuth(instance),
    async signUp(fields) {
      const saved = await test.saveUser(test.createUser(fields));
      const { id, name, email, image } = saved;
      return { id: UserId.parse(id), name, email, image: image ?? null };
    },
    signIn: (userId) => test.getAuthHeaders({ userId }),
    started,
    takeQueued,
    async reset() {
      const tables = [
        "background_migration",
        "document_status",
        "user_document",
        "document",
        "apikey",
        "session",
        "account",
        "verification",
      ];
      await env.DB.batch([
        ...tables.map((t) => prepare(env.DB, sql`DELETE FROM ${sql.id(t)}`)),
        // The system users are the migrations', and keep their bindings; others' go with them
        prepare(env.DB, sql`DELETE FROM "user" WHERE "id" NOT IN ${sql.tuple([SYSTEM_USER, CURATED_USER])}`),
      ]);
      await clearLexicons(lexicon);
      await prepare(env.INGEST_DB, sql`DELETE FROM ingest_job`).run();
      const { objects } = await env.BLOBS.list();
      if (objects.length > 0) await env.BLOBS.delete(objects.map((o) => o.key));
      await takeQueued();
    },
    close: () => server.close(),
  };
}
