import {
  MAX_ANNOTATIONS,
  type Annotation,
  type AnnotationFilter,
  type AnnotationId,
  type AnnotationKey,
  type DocumentFilter,
  type DocumentKey,
  type Tag,
  type TagKey,
  type DocumentId,
  type Licence,
  type UserId,
} from "@skolia/shared/api";
import type { PageRequest } from "@skolia/shared/page";
import {
  and,
  col,
  compile,
  contains,
  desc,
  eq,
  exists,
  fn,
  gt,
  inList,
  is,
  lit,
  lt,
  or,
  row,
  select,
  unionAll,
  type Query,
  type Select,
} from "@skolia/util/query";
import { sql, type Sql } from "@skolia/util/sql";
import type { DocumentContent, DocumentEntry, EntryFields } from "../../ports/documents.ts";
import * as schemas from "@skolia/shared/schemas";
import type * as z from "zod";

const COLUMNS = {
  title: "entry.title",
  importedAt: "entry.imported_at",
  visibility: "entry.visibility",
  licence: "attribution.licence",
  author: "attribution.author",
  source: "attribution.source",
  lang: "document.lang",
  words: "document.words",
  importerName: "user.name",
  statusState: "status.state",
  statusUpdatedAt: "status.updated_at",
  statusData: "status.data",
  tags: select({ tags: fn.jsonGroupObject("tag.kind", "tag.value") })
    .from("user_document_tag", "tag")
    .where(eq("tag.user_id", col("entry.user_id")), eq("tag.document_id", col("entry.document_id"))),
};

const joined = (query: Select): Select =>
  query
    .join("document", eq("document.id", col("entry.document_id")))
    .join("user", eq("user.id", col("entry.user_id")))
    .join("attribution", eq("attribution.id", col("entry.attribution_id")))
    .leftJoin("document_status", "status", eq("status.document_id", col("entry.document_id")));

const SELECT_DOCUMENT = joined(select({ id: "entry.document_id", user: "entry.user_id", ...COLUMNS }).from("user_document", "entry"));

/** Entries by one of their tags: its key columns are the tag row's, so the list's order is
 * user_document_tag_value_idx's within the tag. */
const SELECT_TAGGED = joined(
  select({ id: "tagged.document_id", user: "tagged.user_id", ...COLUMNS })
    .from("user_document_tag", "tagged")
    .join("user_document", "entry", and(eq("entry.user_id", col("tagged.user_id")), eq("entry.document_id", col("tagged.document_id")))),
);

type KindValues = readonly [kind: string, values: readonly string[]];

/** The list's query: a page of the public entries and the viewer's private ones (with
 * mine, the viewer's alone) that the filter keeps, in the order of their key, (user,
 * document), and one more entry if there is one. Each part walks an index in that order
 * from the cursor, and SQLite merges them, so a page reads about a page of entries:
 * - the public entries, by primary key, or with tags, one part for each value of the
 *   first kind, by user_document_tag_value_idx, the other kinds looked up for each entry;
 * - the viewer's own, by primary key, their tags looked up for each entry. */
export function listQuery(
  viewer: UserId | null,
  { tags, lang, title, mine }: DocumentFilter,
  { after, limit }: PageRequest<DocumentKey>,
): Query {
  const kinds: readonly KindValues[] = Object.entries(tags).filter(([, values]) => values.length > 0);
  const [first, ...others] = kinds;
  const narrowed = [lang !== undefined && eq("document.lang", lang), title !== undefined && contains("entry.title", title)];
  const from = (key: "entry" | "tagged") => after !== undefined && gt(row(`${key}.user_id`, `${key}.document_id`), after);
  const own =
    viewer === null
      ? []
      : [
          SELECT_DOCUMENT.where(
            eq("entry.user_id", viewer),
            !mine && eq("entry.visibility", lit("private")),
            from("entry"),
            ...narrowed,
            ...tagged(kinds),
          ),
        ];
  const shared = mine
    ? []
    : first === undefined
      ? [SELECT_DOCUMENT.where(eq("entry.visibility", lit("public")), from("entry"), ...narrowed)]
      : first[1].map((value) =>
          SELECT_TAGGED.where(
            eq("tagged.kind", first[0]),
            eq("tagged.value", value),
            eq("entry.visibility", lit("public")),
            from("tagged"),
            ...narrowed,
            ...tagged(others),
          ),
        );
  return unionAll([...shared, ...own])
    .orderBy("user", "id")
    .limit(limit + 1);
}

/** The entry has one of the values of each kind, looked up by user_document_tag's primary key. */
function tagged(kinds: readonly KindValues[]): readonly Sql[] {
  return kinds.map(([kind, values]) =>
    exists(
      select({})
        .from("user_document_tag", "has")
        .where(
          eq("has.user_id", col("entry.user_id")),
          eq("has.document_id", col("entry.document_id")),
          eq("has.kind", kind),
          inList("has.value", values),
        ),
    ),
  );
}

/** A page of the tags, and one more if there is one. */
export function tagsQuery({ after, limit }: PageRequest<TagKey>): Query {
  return select(["kind", "value", "description", "position"])
    .from("tag")
    .where(after !== undefined && gt(row("kind", "position"), after))
    .orderBy("kind", "position")
    .limit(limit + 1);
}

export function knownQuery(tags: readonly Tag[]): Sql {
  return sql`SELECT kind, value FROM tag WHERE (kind, value) IN (VALUES ${sql.join(
    tags.map(({ kind, value }) => sql.tuple([kind, value])),
    ", ",
  )})`;
}

export function visibleQuery(id: DocumentId, viewer: UserId | null): Query {
  return SELECT_DOCUMENT.where(
    eq("entry.document_id", id),
    or(viewer !== null && eq("entry.user_id", viewer), eq("entry.visibility", lit("public"))),
  )
    .orderBy(desc(is("entry.user_id", viewer)), "entry.imported_at")
    .limit(1);
}

export function hasQuery(id: DocumentId): Sql {
  return sql`SELECT 1 FROM document WHERE id = ${id}`;
}

export function addContentQuery({ id, lang, words }: DocumentContent): Sql {
  return sql`INSERT INTO document (id, lang, words) VALUES ${sql.tuple([id, lang, words])} ON CONFLICT (id) DO NOTHING`;
}

type Attribution = { readonly licence: Licence; readonly author: string | null; readonly source: string | null };

/** Adds the attribution unless there's a row for it already. A row the CHECKs refuse fails. */
export function addAttributionQuery({ licence, author, source }: Attribution): Sql {
  return sql`INSERT INTO attribution (licence, author, source) VALUES ${sql.tuple([licence, author, source])} ON CONFLICT DO NOTHING`;
}

/** The attribution's id, by attribution_credit_idx, for a statement after addAttributionQuery's. */
function attributionId({ licence, author, source }: Attribution): Sql {
  return sql`(SELECT id FROM attribution WHERE licence = ${licence} AND ifnull(author, '') = ${author ?? ""} AND ifnull(source, '') = ${source ?? ""})`;
}

export function addEntryQuery(e: DocumentEntry): Sql {
  return sql`INSERT OR IGNORE INTO user_document (user_id, document_id, title, imported_at, visibility, attribution_id)
    VALUES ${sql.tuple([e.user, e.id, e.title, e.importedAt, e.visibility, attributionId(e)])}`;
}

export function updateQuery(id: DocumentId, user: UserId, fields: EntryFields): Sql {
  return sql`UPDATE user_document SET title = ${fields.title}, visibility = ${fields.visibility}, attribution_id = ${attributionId(fields)}
    WHERE document_id = ${id} AND user_id = ${user}`;
}

export function addTagQuery(user: UserId, id: DocumentId, kind: string, value: string): Sql {
  return sql`INSERT OR IGNORE INTO user_document_tag (user_id, document_id, kind, value) VALUES ${sql.tuple([user, id, kind, value])}`;
}

export function removeTagsQuery(user: UserId, id: DocumentId): Sql {
  return sql`DELETE FROM user_document_tag WHERE user_id = ${user} AND document_id = ${id}`;
}

export function removeQuery(id: DocumentId, user: UserId): Sql {
  return sql`DELETE FROM user_document WHERE document_id = ${id} AND user_id = ${user}`;
}

const SELECT_ANNOTATION = select({
  id: "annotation.id",
  start: "annotation.start",
  end: "annotation.end",
  kind: "annotation.kind",
  data: "annotation.data",
  licence: "attribution.licence",
  author: "attribution.author",
  source: "attribution.source",
  addedAt: "annotation.added_at",
})
  .from("user_document_annotation", "annotation")
  .join("attribution", eq("attribution.id", col("annotation.attribution_id")));

/** A page of the entry's annotations that overlap the range, and one more if there is one,
 * by user_document_annotation_start_idx. The index bounds start; end is checked on each row,
 * so a range late in the text reads the annotations that start before it, at most
 * MAX_ANNOTATIONS. */
export function annotationsQuery(
  id: DocumentId,
  user: UserId,
  { from, to }: AnnotationFilter,
  { after, limit }: PageRequest<AnnotationKey>,
): Query {
  return SELECT_ANNOTATION.where(
    eq("annotation.user_id", user),
    eq("annotation.document_id", id),
    to !== undefined && lt("annotation.start", to),
    from !== undefined && gt("annotation.end", from),
    after !== undefined && gt(row("annotation.start", "annotation.id"), after),
  )
    .orderBy("annotation.start", "annotation.id")
    .limit(limit + 1);
}

/** Inserts the annotation unless the entry has it or has MAX_ANNOTATIONS, by its
 * annotations_count, read in the same statement so two adds at once can't pass the cap.
 * Only a duplicate is skipped: a row the table's CHECKs refuse fails. */
export function annotateQuery(id: DocumentId, user: UserId, a: Annotation): Sql {
  return sql`INSERT INTO user_document_annotation (user_id, document_id, id, start, "end", kind, data, attribution_id, added_at)
    SELECT ${sql.join([user, id, a.id, a.start, a.end, a.kind, JSON.stringify(a.data), attributionId(a), a.addedAt], ", ")}
    WHERE (SELECT annotations_count FROM user_document WHERE user_id = ${user} AND document_id = ${id}) < ${MAX_ANNOTATIONS}
    ON CONFLICT (user_id, document_id, id) DO NOTHING`;
}

/** D1 binds at most 100 parameters to a statement: the user, the document and these ids. */
export function annotationsByIdQuery(id: DocumentId, user: UserId, ids: readonly AnnotationId[]): Query {
  return SELECT_ANNOTATION.where(eq("annotation.user_id", user), eq("annotation.document_id", id), inList("annotation.id", ids));
}

export function unannotateQuery(id: DocumentId, user: UserId, annotationId: AnnotationId): Sql {
  return sql`DELETE FROM user_document_annotation WHERE user_id = ${user} AND document_id = ${id} AND id = ${annotationId}`;
}

const NO_FILTER: DocumentFilter = { tags: {}, lang: undefined, title: undefined, mine: false };
const SOME_KEY = schemas.DocumentKey.parse(["x", "0".repeat(64)]);
const SOMEONE = schemas.UserId.parse("x");
const TWO_KINDS = { level: ["A1", "B1"], form: ["poem"] };
const SOME_ENTRY: DocumentEntry = {
  id: SOME_KEY[1],
  user: SOMEONE,
  importedAt: schemas.Timestamp.parse("2026-11-12T00:00:00.000Z"),
  title: "x",
  visibility: "public",
  licence: "cc0",
  author: null,
  source: null,
  tags: {},
};
const SOME_ANNOTATION: Annotation = {
  id: schemas.AnnotationId.parse("0".repeat(64)),
  start: 0,
  end: 1,
  kind: "audio",
  data: { url: "https://example.org/a.mp3" },
  licence: "cc0",
  author: null,
  source: null,
  addedAt: SOME_ENTRY.importedAt,
};

/** D1Documents' queries, exported for the test that checks each one uses an index. */
export const DOCUMENT_QUERIES = {
  list: compile(listQuery(null, NO_FILTER, { after: undefined, limit: 24 })).text,
  listAfter: compile(listQuery(SOMEONE, NO_FILTER, { after: SOME_KEY, limit: 24 })).text,
  /** The list narrowed to one kind of tag, two of its values */
  listTagged: compile(listQuery(null, { ...NO_FILTER, tags: { level: ["A1", "B1"] } }, { after: SOME_KEY, limit: 24 })).text,
  listTwoKinds: compile(listQuery(SOMEONE, { ...NO_FILTER, tags: TWO_KINDS }, { after: SOME_KEY, limit: 24 })).text,
  listFiltered: compile(listQuery(SOMEONE, { ...NO_FILTER, lang: "pl", title: "x" }, { after: SOME_KEY, limit: 24 })).text,
  listMine: compile(listQuery(SOMEONE, { ...NO_FILTER, mine: true }, { after: undefined, limit: 24 })).text,
  listMineAfter: compile(listQuery(SOMEONE, { ...NO_FILTER, mine: true, tags: TWO_KINDS }, { after: SOME_KEY, limit: 24 })).text,
  tags: compile(tagsQuery({ after: undefined, limit: 100 })).text,
  tagsAfter: compile(tagsQuery({ after: ["level", 0], limit: 100 })).text,
  known: compile(knownQuery([{ kind: "level", value: "A1" }])).text,
  visible: compile(visibleQuery(SOME_ENTRY.id, SOMEONE)).text,
  has: compile(hasQuery(SOME_ENTRY.id)).text,
  setStatus: statusProjectionQuery(SOME_ENTRY.id, { state: "queued", updated: SOME_ENTRY.importedAt }).text,
  addContent: compile(addContentQuery({ id: SOME_ENTRY.id, lang: "pl", words: 1 })).text,
  addAttribution: compile(addAttributionQuery(SOME_ENTRY)).text,
  addEntry: compile(addEntryQuery(SOME_ENTRY)).text,
  update: compile(updateQuery(SOME_ENTRY.id, SOMEONE, SOME_ENTRY)).text,
  addTag: compile(addTagQuery(SOMEONE, SOME_ENTRY.id, "level", "A1")).text,
  removeTags: compile(removeTagsQuery(SOMEONE, SOME_ENTRY.id)).text,
  remove: compile(removeQuery(SOME_ENTRY.id, SOMEONE)).text,
  annotations: compile(annotationsQuery(SOME_ENTRY.id, SOMEONE, { from: undefined, to: undefined }, { after: undefined, limit: 500 })).text,
  annotationsAfter: compile(
    annotationsQuery(SOME_ENTRY.id, SOMEONE, { from: undefined, to: undefined }, { after: [0, SOME_ANNOTATION.id], limit: 500 }),
  ).text,
  annotationsInRange: compile(
    annotationsQuery(SOME_ENTRY.id, SOMEONE, { from: 100, to: 200 }, { after: [0, SOME_ANNOTATION.id], limit: 500 }),
  ).text,
  annotate: annotateQuery(SOME_ENTRY.id, SOMEONE, SOME_ANNOTATION).text,
  annotationsById: compile(annotationsByIdQuery(SOME_ENTRY.id, SOMEONE, [SOME_ANNOTATION.id, SOME_ANNOTATION.id])).text,
  unannotate: unannotateQuery(SOME_ENTRY.id, SOMEONE, SOME_ANNOTATION.id).text,
} as const;

export function statusProjectionQuery(id: DocumentId, { state, updated, ...data }: z.output<typeof schemas.Status>): Sql {
  return sql`INSERT INTO document_status (document_id, state, updated_at, data)
    VALUES (${id}, ${state}, ${updated}, ${JSON.stringify(data)})
    ON CONFLICT (document_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, data = excluded.data`;
}
