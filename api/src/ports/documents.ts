import type { Status } from "@skolia/shared/schema";
import type {
  Annotation,
  AnnotationFilter,
  AnnotationId,
  AnnotationKey,
  AvailableTag,
  DocumentFilter,
  DocumentId,
  DocumentKey,
  Paginated,
  Tag,
  TagKey,
  Timestamp,
  UserId,
  Lang,
  Licence,
  Visibility,
  Tags,
} from "@skolia/shared/api";
import type { PageRequest } from "@skolia/shared/page";

/** A text, stored once however many users import it, and never deleted. Its state lives in
 * the status blob. */
export interface DocumentContent {
  readonly id: DocumentId;
  readonly lang: Lang;
  readonly words: number;
}

/** What a user says about a text they imported. The licence is their claim. */
export interface EntryFields {
  readonly title: string;
  readonly visibility: Visibility;
  readonly licence: Licence;
  readonly author: string | null;
  readonly source: string | null;
  readonly tags: Tags;
}

/** A user's entry for a text they imported. */
export interface DocumentEntry extends EntryFields {
  readonly id: DocumentId;
  readonly user: UserId;
  readonly importedAt: Timestamp;
}

/** An entry with its text's language and word count, and its user's name. */
export interface StoredDocument extends DocumentEntry {
  readonly lang: Lang;
  readonly words: number;
  readonly importerName: string;
  readonly status: Status | null;
}

export interface DocumentLookup {
  /** A page of the public entries and the viewer's private ones, by user then text, that the
   * filter keeps (with mine, the viewer's alone). */
  list(viewer: UserId | null, filter: DocumentFilter, page: PageRequest<DocumentKey>): Promise<Paginated<StoredDocument, DocumentKey>>;
  /** The entry the viewer sees for a text: their own, else its earliest public one. Null
   * for a text that's unknown or private to others. */
  visible(id: DocumentId, viewer: UserId | null): Promise<StoredDocument | null>;
  /** visible's entry for each of the texts that has one. */
  visibleAll(ids: readonly DocumentId[], viewer: UserId | null): Promise<ReadonlyMap<DocumentId, StoredDocument>>;
}

export interface DocumentTags {
  /** A page of the tags that can be given, by kind, then in each kind's order. */
  tags(page: PageRequest<TagKey>): Promise<Paginated<AvailableTag, TagKey>>;
  /** Those of the tags that can be given. */
  known(tags: readonly Tag[]): Promise<readonly Tag[]>;
}

export interface DocumentStatusStore {
  /** Update the list projection when the status blob is published. */
  setStatus(id: DocumentId, status: Status): Promise<void>;
}

export interface DocumentEntries {
  /** Whether the text is stored, whoever imported it. */
  has(id: DocumentId): Promise<boolean>;
  /** Insert the entry, and the content unless it's already there. An existing entry is kept. */
  add(content: DocumentContent, entry: DocumentEntry): Promise<void>;
  /** Its tags replace all the entry had. */
  update(id: DocumentId, user: UserId, fields: EntryFields): Promise<void>;
  /** Delete the user's entry. The text stays, for anyone who imports it again. */
  remove(id: DocumentId, user: UserId): Promise<void>;
}

export interface DocumentAnnotations {
  /** A page of the user's entry's annotations that the filter keeps, by where they start. */
  annotations(
    id: DocumentId,
    user: UserId,
    filter: AnnotationFilter,
    page: PageRequest<AnnotationKey>,
  ): Promise<Paginated<Annotation, AnnotationKey>>;
  /** Add each annotation the user's entry hasn't one with the id of, in one transaction, until
   * it has MAX_ANNOTATIONS. At most ANNOTATION_BATCH. */
  annotate(id: DocumentId, user: UserId, annotations: readonly Annotation[]): Promise<AnnotateResult>;
  /** False if the user's entry has no annotation with the id. */
  unannotate(id: DocumentId, user: UserId, annotationId: AnnotationId): Promise<boolean>;
}

export interface DocumentStore extends DocumentLookup, DocumentTags, DocumentStatusStore, DocumentEntries, DocumentAnnotations {}

/** added: the entry has them all, as they're given here, added of them new. full: it filled
 * up before it had them all; those before stay. */
export type AnnotateResult =
  | { readonly kind: "added"; readonly added: number; readonly annotations: readonly Annotation[] }
  | { readonly kind: "full" };
