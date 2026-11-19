// Run-scoped credentials for the shared API. Keys expire if CI is interrupted before cleanup.
import { createHmac } from "node:crypto";
import { LANGS, type Lang } from "@skolia/shared/api";
import { sql } from "@skolia/util/sql";
import { insertKeySql, keyFromEnv } from "./api-keys.ts";

export const SYSTEM_USER = "system";

export function e2eUserId(run: string, lang: Lang): string {
  return `e2e-${run}-${lang}`;
}

export function e2eUserKey(seed: string, lang: Lang): string {
  return createHmac("sha256", seed).update(lang).digest("hex");
}

export function e2eKeysSql(run: string, keys: { system: string; user: string }, at: string): string[] {
  const expiresAt = new Date(Date.parse(at) + 60 * 60 * 1000).toISOString();
  return [
    insertKeySql(`e2e-${run}`, SYSTEM_USER, keys.system, at, expiresAt),
    ...LANGS.flatMap((lang) => {
      const user = e2eUserId(run, lang);
      return [
        sql.inline(sql`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
          VALUES (${user}, 'End-to-end test', ${`${user}@e2e.skolia.io`}, 0, ${at}, ${at});`),
        insertKeySql(user, user, e2eUserKey(keys.user, lang), at, expiresAt),
      ];
    }),
  ];
}

export function e2eCleanupSql(run: string): string[] {
  return [
    sql.inline(sql`DELETE FROM "apikey" WHERE "id" = ${`e2e-${run}`} AND "referenceId" = ${SYSTEM_USER};`),
    // Deleting users cascades to their keys.
    sql.inline(sql`DELETE FROM "user" WHERE "id" IN ${sql.tuple(LANGS.map((lang) => e2eUserId(run, lang)))};`),
  ];
}

if (import.meta.main) {
  const run = process.env["E2E_RUN_ID"];
  if (!run || !/^[0-9a-f]{32}$/.test(run)) throw new Error("E2E_RUN_ID must be 32 hex characters");
  if (process.env["E2E_KEYS_ACTION"] === "cleanup") {
    console.log(e2eCleanupSql(run).join("\n"));
  } else {
    const [system, user] = [keyFromEnv("E2E_API_KEY"), keyFromEnv("E2E_USER_KEY")];
    if (!system || !user) throw new Error("E2E_API_KEY and E2E_USER_KEY must be 64 hex characters");
    console.log(e2eKeysSql(run, { system, user }, new Date().toISOString()).join("\n"));
  }
}
