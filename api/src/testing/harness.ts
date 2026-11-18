import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { createTestHarness, type TestHarness } from "wrangler";
import { LANGS, type User } from "@skolia/shared/api";
import { UserId, UserType } from "@skolia/shared/schemas";
import * as z from "zod";
import type { IngesterRpc } from "@skolia/ingest/rpc";
import type { IngestJob } from "@skolia/shared/schema";
import { authOptions, toAuth, type AuthConfig } from "../auth.ts";
import type { Auth } from "../ports.ts";
import { sql } from "@skolia/util/sql";
import { lexiconBinding, lexiconsOf, prepare, type LexiconBindings } from "../worker/adapters.ts";
import type { User as UserObject } from "../worker/user.ts";
import type IngestRecorder from "./ingest-recorder.ts";
import type { RecorderEnv } from "./ingest-recorder.ts";

export const ORIGIN = "http://localhost:5173";

const API = new URL("../../", import.meta.url).pathname;
const DIST = `${API}dist/`;

export interface TestEnv extends LexiconBindings {
  DB: D1Database;
  USER: DurableObjectNamespace<UserObject>;
  BLOBS: R2Bucket;
  INGESTER: DurableObjectNamespace<IngesterRpc>;
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
  auth: Auth;
  signUp(fields: { name: string; email: string }): Promise<User>;
  signIn(userId: string): Promise<Headers>;
  takeQueued(): Promise<IngestJob[]>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function startLocal(): Promise<Local> {
  assert.ok(existsSync(`${DIST}main.js`), "api/dist/main.js is missing: just build first");
  const server = createTestHarness({
    root: API,
    workers: [
      { configPath: "./wrangler.jsonc", env: "", prebuiltWorkerDir: DIST, vars: { MUTABLE_FINAL_USER_MIGRATION: "true" } },
      { configPath: "./src/testing/ingest-recorder.jsonc" },
    ],
  });
  await server.listen();
  const worker = server.getWorker<TestEnv>();
  await worker.applyD1Migrations("DB");
  for (const lang of LANGS) await worker.applyD1Migrations(lexiconBinding(lang));
  const ingest = server.getWorker<RecorderEnv, { default: typeof IngestRecorder }>("skolia-ingest");
  await ingest.applyD1Migrations("INGEST_DB");
  const { INGEST_DB } = await ingest.getEnv();
  const env = { ...(await worker.getEnv()), INGEST_DB };
  const recorder = await ingest.getExport();
  const options = authOptions(authConfig(env.DB));
  const instance = betterAuth({ ...options, plugins: [...options.plugins, testUtils()] });
  const { test } = await instance.$context;
  async function takeQueued(): Promise<IngestJob[]> {
    const received = await recorder.received();
    await recorder.clear();
    return received;
  }

  return {
    server,
    env,
    auth: toAuth(instance),
    async signUp(fields) {
      const saved = await test.saveUser(test.createUser(fields));
      const { id, name, email, image } = saved;
      const { type } = z.object({ type: UserType }).parse(saved);
      return { id: UserId.parse(id), name, email, image: image ?? null, type };
    },
    signIn: (userId) => test.getAuthHeaders({ userId }),
    takeQueued,
    async reset() {
      const tables = ["user_document", "document", "apikey", "session", "account", "verification"];
      await env.DB.batch([
        ...tables.map((t) => prepare(env.DB, sql`DELETE FROM ${sql.id(t)}`)),
        // The system users are the migrations'
        prepare(env.DB, sql`DELETE FROM "user" WHERE "type" != 'system'`),
      ]);
      for (const db of Object.values(lexiconsOf(env))) {
        await db.batch(["entry", "featureset", "loaded"].map((t) => prepare(db, sql`DELETE FROM ${sql.id(t)}`)));
      }
      await prepare(env.INGEST_DB, sql`DELETE FROM ingest_job`).run();
      const { objects } = await env.BLOBS.list();
      if (objects.length > 0) await env.BLOBS.delete(objects.map((o) => o.key));
      await takeQueued();
    },
    close: () => server.close(),
  };
}
