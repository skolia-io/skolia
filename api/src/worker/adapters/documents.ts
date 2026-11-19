import * as z from "zod";
import type {
  Annotation,
  AnnotationFilter,
  AnnotationId,
  AnnotationKey,
  DocumentFilter,
  DocumentKey,
  Paginated,
  Tag,
  TagKey,
  DocumentId,
  UserId,
  AvailableTag,
  Tags,
} from "@skolia/shared/api";
import { paginate, type PageRequest } from "@skolia/shared/page";
import type { Query } from "@skolia/util/query";
import type { Sql } from "@skolia/util/sql";
import type {
  AnnotateResult,
  DocumentAnnotations,
  DocumentContent,
  DocumentEntry,
  DocumentEntries,
  DocumentLookup,
  DocumentStatusStore,
  DocumentTags,
  EntryFields,
  StoredDocument,
} from "../../ports/documents.ts";
import { prepare } from "@skolia/util/d1";
import * as schemas from "@skolia/shared/schemas";
import {
  addAttributionQuery,
  addContentQuery,
  addEntryQuery,
  addTagQuery,
  annotateQuery,
  annotationsQuery,
  annotationsByIdQuery,
  hasQuery,
  knownQuery,
  listQuery,
  removeQuery,
  removeTagsQuery,
  statusProjectionQuery,
  tagsQuery,
  unannotateQuery,
  updateQuery,
  visibleQuery,
} from "./document-queries.ts";

const TagRow = schemas.AvailableTag.extend({ position: z.number().int() });
const KnownTag = schemas.AvailableTag.pick({ kind: true, value: true });

const IDS_PER_QUERY = 90;

export class D1Documents implements DocumentLookup, DocumentTags, DocumentStatusStore, DocumentEntries, DocumentAnnotations {
  private readonly db: D1DatabaseSession;

  constructor(db: D1DatabaseSession) {
    this.db = db;
  }

  async list(
    viewer: UserId | null,
    filter: DocumentFilter,
    page: PageRequest<DocumentKey>,
  ): Promise<Paginated<StoredDocument, DocumentKey>> {
    const rows = (await this.all(listQuery(viewer, filter, page))).map((row) => schemas.DocumentRow.parse(row));
    return paginate(
      rows.map((item) => ({ item, key: [item.user, item.id] as const })),
      page.limit,
    );
  }

  async tags(page: PageRequest<TagKey>): Promise<Paginated<AvailableTag, TagKey>> {
    const rows = (await this.all(tagsQuery(page))).map((row) => TagRow.parse(row));
    return paginate(
      rows.map(({ position, ...item }) => ({ item, key: [item.kind, position] as const })),
      page.limit,
    );
  }

  async known(tags: readonly Tag[]): Promise<readonly Tag[]> {
    if (tags.length === 0) return [];
    return (await this.all(knownQuery(tags))).map((row) => KnownTag.parse(row));
  }

  private async all(query: Query | Sql): Promise<readonly Record<string, unknown>[]> {
    const { results } = await prepare(this.db, query).all();
    return results;
  }

  async visible(id: DocumentId, viewer: UserId | null): Promise<StoredDocument | null> {
    const row = await prepare(this.db, visibleQuery(id, viewer)).first();
    return row ? schemas.DocumentRow.parse(row) : null;
  }

  async visibleAll(ids: readonly DocumentId[], viewer: UserId | null): Promise<ReadonlyMap<DocumentId, StoredDocument>> {
    if (ids.length === 0) return new Map();
    const found = await this.db.batch(ids.map((id) => prepare(this.db, visibleQuery(id, viewer))));
    return new Map(
      found.flatMap(({ results: [row] }) => {
        if (row === undefined) return [];
        const document = schemas.DocumentRow.parse(row);
        return [[document.id, document] as const];
      }),
    );
  }

  async setStatus(id: DocumentId, status: z.output<typeof schemas.Status>): Promise<void> {
    await prepare(this.db, statusProjectionQuery(id, status)).run();
  }

  async has(id: DocumentId): Promise<boolean> {
    return (await prepare(this.db, hasQuery(id)).first()) !== null;
  }

  async add(content: DocumentContent, entry: DocumentEntry): Promise<void> {
    await this.db.batch([
      prepare(this.db, addContentQuery(content)),
      prepare(this.db, addAttributionQuery(entry)),
      prepare(this.db, addEntryQuery(entry)),
      ...this.addTags(entry.user, entry.id, entry.tags),
    ]);
  }

  async update(id: DocumentId, user: UserId, fields: EntryFields): Promise<void> {
    await this.db.batch([
      prepare(this.db, addAttributionQuery(fields)),
      prepare(this.db, updateQuery(id, user, fields)),
      prepare(this.db, removeTagsQuery(user, id)),
      ...this.addTags(user, id, fields.tags),
    ]);
  }

  private addTags(user: UserId, id: DocumentId, tags: Tags): D1PreparedStatement[] {
    return Object.entries(tags).flatMap(([kind, value]) =>
      value === undefined ? [] : [prepare(this.db, addTagQuery(user, id, kind, value))],
    );
  }

  async remove(id: DocumentId, user: UserId): Promise<void> {
    await prepare(this.db, removeQuery(id, user)).run();
  }

  async annotations(
    id: DocumentId,
    user: UserId,
    filter: AnnotationFilter,
    page: PageRequest<AnnotationKey>,
  ): Promise<Paginated<Annotation, AnnotationKey>> {
    const rows = (await this.all(annotationsQuery(id, user, filter, page))).map((row) => schemas.AnnotationRow.parse(row));
    return paginate(
      rows.map((item) => ({ item, key: [item.start, item.id] as const })),
      page.limit,
    );
  }

  async annotate(id: DocumentId, user: UserId, annotations: readonly Annotation[]): Promise<AnnotateResult> {
    const attributions = [...new Map(annotations.map((a) => [JSON.stringify([a.licence, a.author, a.source]), a])).values()];
    const ids = [...new Set(annotations.map((a) => a.id))];
    const chunks = Array.from({ length: Math.ceil(ids.length / IDS_PER_QUERY) }, (_, i) =>
      ids.slice(i * IDS_PER_QUERY, (i + 1) * IDS_PER_QUERY),
    );
    const results = await this.db.batch([
      ...attributions.map((a) => prepare(this.db, addAttributionQuery(a))),
      ...annotations.map((a) => prepare(this.db, annotateQuery(id, user, a))),
      ...chunks.map((chunk) => prepare(this.db, annotationsByIdQuery(id, user, chunk))),
    ]);
    const inserted = results.slice(attributions.length, attributions.length + annotations.length);
    const stored = new Map(
      results
        .slice(attributions.length + annotations.length)
        .flatMap((r) => r.results.map((row) => schemas.AnnotationRow.parse(row)))
        .map((a) => [a.id, a]),
    );
    const found = annotations.flatMap((a) => stored.get(a.id) ?? []);
    if (found.length < annotations.length) return { kind: "full" };
    // changes counts the trigger's update of annotations_count too
    return { kind: "added", added: inserted.filter((r) => r.meta.changes > 0).length, annotations: found };
  }

  async unannotate(id: DocumentId, user: UserId, annotationId: AnnotationId): Promise<boolean> {
    return (await prepare(this.db, unannotateQuery(id, user, annotationId)).run()).meta.changes > 0;
  }
}
