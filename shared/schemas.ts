import * as z from "zod";
import {
  ANNOTATION_BATCH,
  ANNOTATION_PAGE,
  CARD_GROUPS,
  CARD_PAGE,
  CARD_STATES,
  DOCUMENT_PAGE,
  TAG_PAGE,
  LANGS,
  LICENCES,
  MAX_ANNOTATION_TEXT,
  MAX_AUTHOR_LENGTH,
  MAX_CLOZE_SENTENCE,
  MAX_CLOZE_WHY,
  MAX_LEMMA_LENGTH,
  MAX_NEW_PER_DAY,
  MAX_SOURCE_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_TAGS,
  RATINGS,
  READING_PAGE,
  SCHEDULE_STATUSES,
  SHAREABLE_LICENCES,
  TAG_KIND,
  TAG_VALUE,
  UPOS,
  ROLE_NAMES,
  VISIBILITIES,
  WORD_CARD_KINDS,
  isShareable,
  parseTag,
  tagFilter,
} from "./api.ts";
import { pageQuery, type Cursor } from "./page.ts";
import type { Status as StatusType, Versions as VersionsType } from "./schema.gen.ts";
import * as gen from "./schema.zod.gen.ts";

export const Lang = z.enum(LANGS).meta({ id: "Lang" });

/** A time as toISOString() writes it, 2026-11-08T10:00:00.000Z: what's stored, and
 * compared as strings, which sort in time order. timestamp() makes one. */
export const Timestamp = z.iso.datetime({ precision: 3 }).brand<"Timestamp">().meta({ id: "Timestamp" });

/** Better Auth's user id. */
export const UserId = z.string().min(1).brand<"UserId">().meta({ id: "UserId" });

/** sha256 hex of a document's language and text (docId in keys.ts). */
export const DocumentId = z
  .string()
  .regex(/^[0-9a-f]{64}$/u)
  .brand<"DocumentId">()
  .meta({ id: "DocumentId" });

export const CardId = z.uuid().brand<"CardId">().meta({ id: "CardId" });

/** Made by the client, so a retried review isn't counted twice. */
export const ReviewId = z.uuid().brand<"ReviewId">();

export const Visibility = z.enum(VISIBILITIES).meta({ id: "Visibility" });
export const RoleName = z.enum(ROLE_NAMES);

export const LemmaId = z
  .templateLiteral([Lang, ":", z.string().min(1).max(MAX_LEMMA_LENGTH), ":", z.enum(UPOS)])
  .meta({ id: "LemmaId", description: "{lang}:{lemma}:{upos}, pl:pies:NOUN" });

const PerDay = z.number().int().min(0).max(MAX_NEW_PER_DAY);

/** newLemmasPerDay: new words a day, each with all its word cards; newFormsPerDay: new
 * cloze cards a day; formsWithWords: one review session for both, or one for each. */
export const Settings = z.object({ newLemmasPerDay: PerDay, newFormsPerDay: PerDay, formsWithWords: z.boolean() });

/** An ISO 8601 UTC time as a client sends it, any precision; timestamp(new Date(t)) for
 * the stored form. */
const IsoTime = z.iso.datetime().meta({ id: "IsoTime", description: "An ISO 8601 UTC time, any precision" });

/** at: when it was answered. */
export const ReviewRequest = z.object({
  id: ReviewId,
  cardId: CardId,
  rating: z.union(RATINGS.map((r) => z.literal(r))),
  at: IsoTime,
});

/** The start of the reader's day, for counting today's new cards in its time zone. */
const Index = z.number().int().min(0).max(MAX_TEXT_LENGTH);
/** An offset into a text in UTF-16 code units: a JavaScript string index. */
const TextOffset = z.number().int().min(0).max(MAX_TEXT_LENGTH);

/** Where a reader was in a text: the word at the top of their screen, by sentence and
 * token index in its analysis, and when they were there, so an older position doesn't
 * replace a newer one. */
export const ReadingPosition = z.object({ sentence: Index, token: Index, at: IsoTime });
/** A position as it's kept, its time a Timestamp. */
export const StoredPosition = ReadingPosition.extend({ at: Timestamp });

export const ReadingListId = z.number().int().positive().brand<"ReadingListId">().meta({ id: "ReadingListId" });
export const ReadingListIdParam = z
  .string()
  .regex(/^[1-9][0-9]*$/u)
  .transform(Number)
  .pipe(ReadingListId);
export const ReadingListName = z.object({ name: z.string().trim().min(1).max(100) });
export const ReadingList = ReadingListName.extend({
  id: ReadingListId,
  documentsCount: z.number().int().nonnegative(),
  createdAt: Timestamp,
});
export const ReadingListDocument = z.object({ document: z.lazy(() => DocumentSummary), createdAt: Timestamp });

export const ReadingKey = z.tuple([Timestamp, DocumentId]).readonly();
export const ReadingListDocumentsQuery = pageQuery(ReadingKey, READING_PAGE).extend({ lang: Lang.optional() });

export const CountsQuery = z.object({ dayStart: IsoTime });
/** group: only its cards; without one, both groups'. */
export const DueQuery = z.object({ lang: Lang, dayStart: IsoTime, group: z.enum(CARD_GROUPS).optional() });

export const Cloze = z.object({
  documentId: DocumentId,
  sentence: z.string().min(1).max(MAX_CLOZE_SENTENCE),
  sentenceStart: TextOffset,
  blankStart: TextOffset,
  blankEnd: TextOffset,
  feats: z.record(z.string(), z.string()),
  why: z.string().max(MAX_CLOZE_WHY).nullable(),
});

/** A new cloze card's data: the blank, like the sentence, is offsets in the text, and must
 * be inside the sentence. */
export const NewCloze = Cloze.refine(
  (c) =>
    c.sentenceStart <= c.blankStart &&
    c.blankStart < c.blankEnd &&
    c.blankEnd <= c.sentenceStart + c.sentence.length &&
    c.sentence.slice(c.blankStart - c.sentenceStart, c.blankEnd - c.sentenceStart).trim() !== "",
  { message: "the blank must be a word in the sentence" },
);

/** A word's card has no data of its own: its lemma is what it asks. */
const WordCardData = z.strictObject({});

/** What a card holds beyond what every card has, by kind. recognition and production:
 * nothing. cloze: its sentence and blank. The database checks only that data is an object;
 * a new kind is a variant here. */
export const CardContent = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(WORD_CARD_KINDS), data: WordCardData }),
  z.object({ kind: z.literal("cloze"), data: Cloze }),
]);

/** A card to make for the word: a recognition or production card, one of each per word,
 * data left out; or a cloze card, any number per word, one per blank in a text. */
export const NewCard = z
  .intersection(
    z.object({ lemmaId: LemmaId }),
    z.discriminatedUnion("kind", [
      z.object({ kind: z.enum(WORD_CARD_KINDS), data: WordCardData.default({}) }),
      z.object({ kind: z.literal("cloze"), data: NewCloze }),
    ]),
  )
  .meta({ id: "NewCard" });

export const CardState = z.enum(CARD_STATES).meta({ id: "CardState" });

/** What changes in a card: its state. */
export const CardChange = z.object({ state: CardState }).meta({ id: "CardChange" });

export const ScheduleStatus = z.enum(SCHEDULE_STATUSES);

/** A card as the list of them has it. state: whether it's reviewed (learning) or known.
 * scheduledDays: the interval its last review gave it. lastReviewedAt: when it was last
 * answered, by the reviewer's clock. */
export const Card = z
  .intersection(
    z.object({
      id: CardId,
      lemmaId: LemmaId,
      createdAt: Timestamp,
      state: CardState,
      scheduleStatus: ScheduleStatus,
      dueAt: Timestamp,
      scheduledDays: z.number().min(0),
      lastReviewedAt: Timestamp.nullable(),
    }),
    CardContent,
  )
  .meta({ id: "Card" });

/** Where a card is in a language's list: newest first, then by id. */
export const NewestCardKey = z.tuple([Timestamp, CardId]).readonly();
/** Where a card is in a text's list: where its blank starts. */
export const TextCardKey = z.tuple([TextOffset]).readonly();
export const CardKey = z.union([NewestCardKey, TextCardKey]);

/** A page of the user's cards: a language's (lang) or a word's (lemmaId), newest first; or
 * a text's cloze cards (documentId), in the order of the text. One of the three, and a
 * cursor the same kind of list gave. */
export const CardsQuery = pageQuery(CardKey, CARD_PAGE)
  .extend({ lang: Lang.optional(), lemmaId: LemmaId.optional(), documentId: DocumentId.optional() })
  .transform(({ lang, lemmaId, documentId, after, limit }, context) => {
    if ([lang, lemmaId, documentId].filter((given) => given !== undefined).length !== 1) {
      context.addIssue({ code: "custom", message: "give one of lang, lemmaId and documentId" });
      return z.NEVER;
    }
    if (after !== undefined && after.length !== (documentId === undefined ? 2 : 1)) {
      context.addIssue({ code: "custom", message: "after isn't a cursor this list gave" });
      return z.NEVER;
    }
    if (documentId !== undefined) return { documentId, after: after as z.output<typeof TextCardKey> | undefined, limit };
    const newest = after as z.output<typeof NewestCardKey> | undefined;
    return lemmaId !== undefined ? { lemmaId, after: newest, limit } : { lang: lang!, after: newest, limit };
  });

const ScheduledFields = z.object({ id: CardId, lemmaId: LemmaId, isNew: z.boolean(), dueAt: Timestamp });

export const ScheduledCard = z.intersection(ScheduledFields, CardContent);

export const Licence = z.enum(LICENCES).meta({ id: "Licence" });

const Source = z
  .string()
  .max(MAX_SOURCE_LENGTH)
  .refine((s) => /^https?:\/\/\S+$/u.test(s), "source must be an http(s) URL");

export const TagKind = z.string().regex(TAG_KIND, "a tag's kind is lowercase letters, digits and hyphens");
export const TagValue = z.string().regex(TAG_VALUE, "a tag's value is letters, digits and . + -");

/** An entry's tags, each kind to its value; GET /api/tags has the ones skolia has. */
export const Tags = z.record(TagKind, TagValue).refine((tags) => Object.keys(tags).length <= MAX_TAGS, `at most ${MAX_TAGS} tags`);

export const AvailableTag = z.object({ kind: TagKind, value: TagValue, description: z.string().nullable() });

/** Where a tag is in the list of them: by kind, then in the kind's order. */
export const TagKey = z.tuple([TagKind, z.number().int()]).readonly();
export const TagsQuery = pageQuery(TagKey, TAG_PAGE);

/** See DocumentKey in api.ts. */
export const DocumentKey = z.tuple([UserId, DocumentId]).readonly();

/** A page of the viewer's own documents. */
export const MyDocumentsQuery = pageQuery(DocumentKey, DOCUMENT_PAGE);

/** A page of the documents list. tag=kind:value, once or more, keeps entries with any of
 * the values of each kind given; lang, those in the language; q, those whose title has
 * it; mine=true, only the viewer's own. */
export const DocumentsQuery = MyDocumentsQuery.extend({
  lang: Lang.optional(),
  q: z
    .string()
    .trim()
    .max(MAX_TITLE_LENGTH)
    .transform((q) => q || undefined)
    .optional(),
  mine: z.stringbool().default(false),
  tag: z
    .union([z.string(), z.array(z.string())])
    .transform((tags, context) =>
      tagFilter(
        (Array.isArray(tags) ? tags : [tags]).flatMap((text) => {
          const tag = parseTag(text);
          if (tag === null) context.addIssue({ code: "custom", message: `${text} isn't a tag, kind:value` });
          return tag === null ? [] : [tag];
        }),
      ),
    )
    .optional(),
});

export const ImportRequest = z
  .object({
    title: z.string().optional(),
    text: z
      .string()
      .refine((t) => t.trim() !== "", "text must be a non-empty string")
      .refine((t) => t.length <= MAX_TEXT_LENGTH, `text is longer than ${MAX_TEXT_LENGTH} characters`),
    lang: Lang,
    visibility: Visibility.default("private"),
    licence: Licence.default("unknown"),
    author: z.string().max(MAX_AUTHOR_LENGTH).optional(),
    source: Source.optional(),
    tags: Tags.default({}),
  })
  .refine((r) => r.visibility === "private" || isShareable(r.licence), {
    message: "a public text needs a licence that allows sharing it",
    path: ["licence"],
  });

export const DocumentUpdate = z.object({
  title: z.string().trim().min(1, "title must be non-empty").max(MAX_TITLE_LENGTH).optional(),
  licence: Licence.optional(),
  author: z.string().trim().max(MAX_AUTHOR_LENGTH).nullable().optional(),
  source: Source.nullable().optional(),
  visibility: Visibility.optional(),
  tags: Tags.optional(),
});

/** sha256 hex of what an annotation says (annotationId in annotations.ts). */
export const AnnotationId = z
  .string()
  .regex(/^[0-9a-f]{64}$/u)
  .brand<"AnnotationId">()
  .meta({ id: "AnnotationId" });

/** A kind's data: its fields, and no others. */
function kindData<S extends z.ZodRawShape>(kind: string, shape: S) {
  const fields = Object.keys(shape).join(", ");
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? `${kind} annotation data has only ${fields}`
        : issue.input === undefined
          ? `${kind} annotation data must be {${fields}}`
          : undefined,
  });
}

/** A field's own message, or one saying it's missing. */
function field(kind: string, name: string, message: string) {
  return {
    error: (issue: { readonly input?: unknown }) => (issue.input === undefined ? `${kind} annotation data needs ${name}` : message),
  };
}

/** What an annotation holds, by kind. audio: a recording of the range, at an https URL
 * skolia doesn't host. text: anything written about the range, a note or a translation,
 * say. The database checks only that data is an object; a new kind is a variant here. */
export const AnnotationContent = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("audio"),
      data: kindData("audio", {
        url: z.url({ protocol: /^https$/u, ...field("audio", "a url", "url must be an https URL") }).max(MAX_SOURCE_LENGTH),
      }),
    }),
    z.object({
      kind: z.literal("text"),
      data: kindData("text", {
        text: z
          .string(field("text", "text", "text must be a string"))
          .trim()
          .min(1, "text must be non-empty")
          .max(MAX_ANNOTATION_TEXT, `text is at most ${MAX_ANNOTATION_TEXT} characters`),
      }),
    }),
  ],
  { error: "kind must be audio or text" },
);

export const Annotation = z
  .intersection(
    z.object({
      id: AnnotationId,
      start: TextOffset,
      end: TextOffset,
      licence: z.enum(SHAREABLE_LICENCES),
      author: z.string().nullable(),
      source: z.string().nullable(),
      addedAt: Timestamp,
    }),
    AnnotationContent,
  )
  .meta({ id: "Annotation" });

/** Whose an annotation is, and the licence it's under. */
export const AnnotationAttribution = z.object({
  licence: z.enum(SHAREABLE_LICENCES, "an annotation needs a licence that allows sharing it"),
  author: z.string().trim().min(1, "author must be non-empty").max(MAX_AUTHOR_LENGTH).optional(),
  source: Source.optional(),
});

/** An annotation to add: its data must be its kind's, and it must end after it starts. That
 * it ends within the text is checked against the text. */
export const NewAnnotation = z
  .intersection(z.object({ start: TextOffset, end: TextOffset, ...AnnotationAttribution.shape }), AnnotationContent)
  .refine((a) => a.start < a.end, { message: "an annotation must end after it starts", path: ["end"] })
  .transform((a) => ({ ...a, author: a.author ?? null, source: a.source ?? null }));

/** Annotations to add to an entry in one request, all or, when it fills up, some. */
export const NewAnnotations = z.object({ annotations: z.array(NewAnnotation).min(1).max(ANNOTATION_BATCH) });
/** The annotations, in the order given, as the entry has them, and how many of them are new. */
export const Annotated = z.object({ added: z.number().int().min(0), annotations: z.array(Annotation) });

export const AnnotationKey = z.tuple([TextOffset, AnnotationId]).readonly();
/** A TextOffset in a query string. */
const Offset = z.coerce.number().int().min(0).max(MAX_TEXT_LENGTH);
/** A page of an entry's annotations; from and to, only those overlapping [from, to). */
export const AnnotationsQuery = pageQuery(AnnotationKey, ANNOTATION_PAGE)
  .extend({ from: Offset.optional(), to: Offset.optional() })
  .refine((q) => q.from === undefined || q.to === undefined || q.from < q.to, { message: "from must be before to", path: ["to"] });

/** An annotation as D1 has it, its data a JSON string. */
export const AnnotationRow = z
  .looseObject({ data: z.string() })
  .transform((row) => ({ ...row, data: JSON.parse(row.data) as unknown }))
  .pipe(Annotation);

export const State = gen.State;

export const Status = z.discriminatedUnion("state", [
  z.object({ state: z.literal("queued"), updated: z.string(), artifacts: gen.ReadyAnalysis.exactOptional() }),
  z.object({ state: z.literal("ready"), updated: z.string(), artifacts: gen.ReadyAnalysis }),
  z.object({ state: z.literal("failed"), updated: z.string(), error: z.string(), artifacts: gen.ReadyAnalysis.exactOptional() }),
]) satisfies z.ZodType<StatusType>;

export const Versions = z.object({
  analyzer: z.string(),
  lexicon: z.string(),
  analysis: z.string(),
  bundle: z.string(),
}) satisfies z.ZodType<VersionsType>;

export const DocumentRow = z
  .object({
    statusState: z.enum(["queued", "ready", "failed"]).nullable(),
    statusUpdatedAt: Timestamp.nullable(),
    statusData: z
      .string()
      .transform((json) => JSON.parse(json) as unknown)
      .pipe(z.record(z.string(), z.unknown()))
      .nullable(),
    id: DocumentId,
    title: z.string(),
    lang: Lang,
    importedAt: Timestamp,
    words: z.number().int(),
    user: UserId,
    visibility: Visibility,
    licence: Licence,
    author: z.string().nullable(),
    source: z.string().nullable(),
    importerName: z.string(),
    /** The entry's user_document_tag rows, as a JSON object of kind to value. */
    tags: z
      .string()
      .transform((json) => JSON.parse(json) as unknown)
      .pipe(Tags),
  })
  .transform(({ statusState, statusUpdatedAt, statusData, ...document }) => ({
    ...document,
    status: statusState === null ? null : Status.parse({ ...statusData, state: statusState, updated: statusUpdatedAt }),
  }));

// Responses. The API's types (api.ts) are these schemas' outputs, and its OpenAPI spec is
// made from them; the API doesn't parse what it sends with them.

export const ApiError = z.object({ error: z.string() }).meta({ id: "ApiError" });

export const Version = z.object({ version: z.string() }).meta({ id: "Version" });

export const User = z
  .object({ id: UserId, name: z.string(), email: z.string(), image: z.string().nullable(), type: RoleName })
  .meta({ id: "User" });

/** A page of a list. next: the cursor for the page after it (?after=), null on the last page. */
export function page<T extends z.ZodType, K>(item: T) {
  // A cursor is a string; the cast types it as its list's, as encodeCursor does
  const next = z.string() as unknown as z.ZodType<Cursor<K>>;
  return z.object({ items: z.array(item), next: next.nullable() });
}

export const QueuePlace = z.object({ starting: z.boolean(), ahead: z.number().int().nullable() }).meta({
  id: "QueuePlace",
  description:
    "starting: the language's analyser is starting, its container booting or its model loading. " +
    "ahead: how many texts it analyses before this one, the one it's analysing included; null when it hasn't been handed this one yet.",
});

/** A stage of an ingest job, in the order they run (analysis/src/skolia_analysis/ingest/worker.py) */
export const IngestStage = z
  .enum([
    "reading",
    "loading-analysis",
    "analysing",
    "bundling",
    "compressing-analysis",
    "uploading-analysis",
    "compressing-bundle",
    "uploading-bundle",
  ])
  .meta({ id: "IngestStage" });

export const IngestOutcome = z.enum(["ready", "failed", "retried"]).meta({
  id: "IngestOutcome",
  description: "retried: storage failed and the job went back in line, to run again as another job.",
});

export const StageTime = z.object({ stage: IngestStage, ms: z.number().int().min(0) }).meta({ id: "StageTime" });

const IngestJobId = z.string().min(1).max(64);
/** The longest error a job's attempt can have, in UTF-16 code units (http.py MAX_ERROR) */
export const MAX_INGEST_ERROR = 2000;
const Size = z.number().int().min(0).nullable();

/** A job in an ingest container (http.py ContainerJob): running, or waiting its turn */
export const ContainerJob = z.object({
  id: IngestJobId,
  doc: DocumentId,
  lang: Lang,
  acceptedAt: Timestamp,
  startedAt: Timestamp.nullable(),
  stage: IngestStage.nullable(),
  stageStartedAt: Timestamp.nullable(),
  chars: Size,
  words: Size,
  stages: z.array(StageTime),
});

/** GET /jobs of a language's ingest container (http.py JobsState). Older containers lack
 * what comes after waiting. */
export const ContainerJobs = z.object({
  loading: z.boolean(),
  running: z.array(z.string()),
  waiting: z.array(z.string()),
  startedAt: Timestamp.optional(),
  jobs: z.array(ContainerJob).default([]),
});

/** How a job ended. chars and words are null for one that failed before it read the text. */
export const IngestResult = z
  .object({
    finishedAt: Timestamp,
    outcome: IngestOutcome,
    error: z.string().max(MAX_INGEST_ERROR).nullable(),
    chars: Size,
    words: Size,
    stages: z.array(StageTime).max(32).describe("The stages it ran, in order, the one it failed in included."),
  })
  .meta({ id: "IngestResult" });

const StartedFields = {
  id: IngestJobId,
  doc: DocumentId,
  lang: Lang,
  image: z.string().min(1).max(200),
  acceptedAt: Timestamp,
  startedAt: Timestamp,
};

/** How a job ended, for the document's status (ingest/schema.py) */
export const JobResult = gen.JobResult;

/** What an ingest container answers to POST /jobs, once the job has run: its result, and
 * its attempts for the history (ingest/schema.py) */
export const JobAnswer = gen.JobAnswer;

/** An IngestWorkflow instance (ingest/src/workflow.ts): one document made to one bundle
 * version, `{doc}-{short hash of the bundle name}` (api/src/worker/adapters/ingest.ts runId) */
export const IngestRunId = z
  .string()
  .regex(/^[0-9a-f]{64}-[0-9a-f]{12}$/u)
  .brand<"IngestRunId">();

const JsonStages = z.string().transform((stages, ctx) => {
  const parsed = z.array(StageTime).safeParse(JSON.parse(stages));
  if (parsed.success) return parsed.data;
  ctx.addIssue({ code: "custom", message: "stages isn't a list of stage times" });
  return z.NEVER;
});

/** An ingest_job row (ingest/migrations): its result is null for a job that started before
 * runs recorded jobs whole, and never finished */
export const IngestJobRow = z
  .object({
    ...StartedFields,
    finishedAt: Timestamp.nullable(),
    outcome: IngestOutcome.nullable(),
    error: z.string().nullable(),
    chars: Size,
    words: Size,
    stages: JsonStages.nullable(),
  })
  .transform(({ finishedAt, outcome, error, chars, words, stages, ...started }) => ({
    ...started,
    result: finishedAt === null || outcome === null || stages === null ? null : { finishedAt, outcome, error, chars, words, stages },
  }));

export const IngestedDocument = z
  .object({ id: DocumentId, title: z.string() })
  .nullable()
  .meta({ id: "IngestedDocument", description: "The text, with the title the viewer sees; null for one the viewer can't see." });

export const LiveIngestJob = ContainerJob.omit({ doc: true }).extend({ document: IngestedDocument }).meta({ id: "LiveIngestJob" });

export const PastIngestJob = z
  .object({
    id: IngestJobId,
    document: IngestedDocument,
    lang: Lang,
    image: z.string().describe("The analysis image that ran it."),
    acceptedAt: Timestamp,
    startedAt: Timestamp,
    result: IngestResult.nullable().describe(
      "Null for a job that started and hasn't finished, and that no analyser is running: its container stopped first, or its result is on its way. The error is null for a text the viewer can't see.",
    ),
  })
  .meta({ id: "PastIngestJob" });

export const IngestContainer = z
  .object({
    startedAt: Timestamp.nullable(),
    loading: z.boolean().describe("Whether it's still loading its models; jobs wait till it's done."),
    jobs: z.array(LiveIngestJob).describe("Running, then waiting, in the order they run."),
  })
  .meta({ id: "IngestContainer" });

export const IngestLanguage = z
  .object({ lang: Lang, container: IngestContainer.nullable().describe("Null when none is running.") })
  .meta({ id: "IngestLanguage" });

export const IngestOverview = z
  .object({
    languages: z.array(IngestLanguage),
    recent: z.array(PastIngestJob).describe("The jobs started most recently, newest first, but those an analyser is running."),
  })
  .meta({ id: "IngestOverview" });

export const ReadingNames = z.object({ analysis: z.string(), bundle: z.string() }).meta({ id: "ReadingNames" });

export const DocumentSummary = z
  .object({
    id: DocumentId.describe("The text's: the same text imported twice in one language is one document."),
    title: z.string(),
    lang: Lang,
    importedAt: Timestamp,
    words: z.number().int(),
    visibility: Visibility,
    licence: Licence,
    author: z.string().nullable().describe("Who wrote the text, as the uploader gives it."),
    source: z.string().nullable().describe("An http(s) URL of where the text is from."),
    tags: z.record(z.string(), z.string()),
    importer: z.object({ id: UserId, name: z.string() }).describe("The entry's user: with id, the summary is one (document, user) pair."),
    mine: z.boolean().describe("Whether it's the viewer's entry, so they can change or delete it."),
    queue: QueuePlace.optional().describe(
      "Where it is in its language's analysis queue: for the viewer's own document, while it's queued or analysing, when it's asked for on its own.",
    ),
    state: State,
    reading: ReadingNames.optional().describe(
      "The analysis and bundle to show, by name (GET .../analysis/{name}): the current ones, or while newer ones are queued or analysing (or failed), the previous ones. Absent until a first analysis is ready.",
    ),
    error: z.string().optional(),
  })
  .meta({
    id: "DocumentSummary",
    description:
      "One user's entry for a text: the viewer's own, or someone's public one. Its title, visibility, licence, author and source are that user's.",
  });

export const FeatureSets = z.record(z.string(), gen.Feats).meta({
  id: "FeatureSets",
  description:
    'The feature sets a response\'s paradigms use, by id: { "50": { Case: "Gen", ... } }. An id means something only within its language\'s loaded lexicon.',
});

export const Relation = gen.Relation;

export const Entry = gen.Entry;

export const Lookup = z.object({ entries: z.array(gen.Entry), featureSets: z.partialRecord(Lang, FeatureSets) }).meta({
  id: "Lookup",
  description:
    'The entries asked for that the lexicon has, as a bundle carries them. Their paradigms\' forms point into feature sets, ["psa", [50, 51]], which featureSets has by language.',
});

export const DueCard = z.intersection(ScheduledFields.extend({ entry: gen.Entry.nullable() }), CardContent).meta({ id: "DueCard" });

const Count = z.number().int().min(0);

export const NewLeft = z.object({ words: Count, forms: Count }) satisfies z.ZodType<Record<(typeof CARD_GROUPS)[number], number>>;

export const Due = z.object({ cards: z.array(DueCard), newLeft: NewLeft, featureSets: FeatureSets }).meta({ id: "Due" });

export const Tally = z.object({ due: Count, new: Count });

export const CardCounts = z.object({ lang: Lang, words: Tally, forms: Tally }).meta({ id: "CardCounts" });

export const Reviewed = z.object({ cardId: CardId, dueAt: Timestamp });

export const CardMade = z.object({ cardId: CardId }).meta({ id: "CardMade" });
