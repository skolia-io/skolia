import * as z from "zod";
import { Status, StoredStatus } from "@skolia/shared/schemas";
import { sql } from "@skolia/util/sql";
import { prepare } from "../adapters.ts";
import type { BackgroundMigration } from "./runner.ts";

const PAGE = 48;
const Projection = z.object({ document_id: z.string(), status: z.string() });
const STATUS_KEY = /^doc\/[a-f0-9]{64}\/status\.json$/u;

/** Undefined means already canonical; null means the old value is unreadable. */
function convert(raw: string): string | undefined | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null) return undefined;
  const flat = typeof value === "object" && ["analyzer", "lexicon", "analysis", "bundle"].some((key) => key in value);
  if (!flat && Status.safeParse(value).success) return undefined;
  const legacy = StoredStatus.safeParse(value);
  return legacy.success ? JSON.stringify(legacy.data) : null;
}

export const nestDocumentStatus: BackgroundMigration = {
  version: 2,
  name: "nest-document-status",
  async run({ db, bucket }, cursor) {
    if (cursor?.startsWith("d1:")) {
      const { results } = await prepare(
        db,
        sql`SELECT document_id, status FROM document_status
        WHERE document_id > ${cursor.slice(3)} ORDER BY document_id LIMIT ${PAGE}`,
      ).all();
      const rows = results.map((row) => Projection.parse(row));
      const writes = rows.flatMap(({ document_id: id, status }) => {
        const nested = convert(status);
        return nested === undefined
          ? []
          : [
              prepare(
                db,
                sql`UPDATE document_status SET status = ${nested ?? "null"}
          WHERE document_id = ${id} AND status = ${status}`,
              ),
            ];
      });
      if (writes.length > 0) await db.batch(writes);
      const last = rows.at(-1);
      return { cursor: last === undefined ? cursor : `d1:${last.document_id}`, done: rows.length < PAGE };
    }

    // Scan the bucket, not the document table: a run can publish before import
    // creates a row. Ignore texts, analysis and bundle objects without reading them.
    const page = await bucket.list({ prefix: "doc/", limit: PAGE, ...(cursor === null ? {} : { cursor: cursor.slice(3) }) });
    const keys = page.objects.map((object) => object.key).filter((key) => STATUS_KEY.test(key));
    for (let offset = 0; offset < keys.length; offset += 6) {
      await Promise.all(
        keys.slice(offset, offset + 6).map(async (key) => {
          const object = await bucket.get(key);
          if (object === null) return;
          const nested = convert(await object.text());
          // Leave unreadable blobs alone. The reader already treats them as absent.
          if (nested == null) return;
          await bucket.put(key, nested, {
            onlyIf: { etagMatches: object.etag },
            ...(object.httpMetadata === undefined ? {} : { httpMetadata: object.httpMetadata }),
            ...(object.customMetadata === undefined ? {} : { customMetadata: object.customMetadata }),
          });
        }),
      );
    }
    return { cursor: page.truncated ? `r2:${page.cursor}` : "d1:", done: false };
  },
};
