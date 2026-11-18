import * as z from "zod";
import { DocumentId } from "@skolia/shared/schemas";
import { sql } from "@skolia/util/sql";
import { readStatus } from "../../controllers/documents.ts";
import { prepare, statusProjectionQuery } from "../adapters.ts";
import type { BackgroundMigration } from "./runner.ts";

const PAGE = 24;
const Row = z.object({ id: DocumentId, projected: z.number() });

export const documentStatus: BackgroundMigration = {
  version: 1,
  name: "document-status",
  async run({ db, blobs }, cursor) {
    const { results } = await prepare(
      db,
      sql`SELECT document.id,
      EXISTS (SELECT 1 FROM document_status WHERE document_id = document.id) AS projected
      FROM document WHERE id > ${cursor ?? ""} ORDER BY id LIMIT ${PAGE}`,
    ).all();
    const rows = results.map((row) => Row.parse(row));
    // At most six R2 reads at once, never a read for an already published projection.
    for (let start = 0; start < rows.length; start += 6) {
      const statements = await Promise.all(
        rows
          .slice(start, start + 6)
          .filter((row) => !row.projected)
          .map(async ({ id }) => prepare(db, statusProjectionQuery(id, await readStatus(blobs, id), false))),
      );
      if (statements.length > 0) await db.batch(statements);
    }
    return { cursor: rows.at(-1)?.id ?? cursor, done: rows.length < PAGE };
  },
};
