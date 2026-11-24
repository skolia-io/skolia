// The reader as built (dist/) and the API's own Hono app (createApp), both served to the
// page by page.route. The app runs on in-memory ports typed by its Deps, so the
// screenshots need no Worker, database or ingest, and a change to a port or a route's
// response fails tsc -p screenshots. The text is the start of Prus's Lalka (public
// domain), its analysis as ingest stored it, with a recording of each
// paragraph: silence, served from AUDIO.
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import type { Page, Route } from "@playwright/test";
import { createApp } from "@skolia/api/app";
import { createApp as createLexiconApp, type Found, type Lexicon } from "@skolia/lexicon/app";
import {
  blankOut,
  matchesTags,
  type Annotation,
  type Card,
  type Cloze,
  type DocumentId as DocumentIdType,
  type Lang,
  type LemmaId as LemmaIdType,
  type ScheduledCard,
  type ReadingList,
  type ReadingListId as ReadingListIdType,
  type Settings,
  type User,
  type UserId as UserIdType,
} from "@skolia/shared/api";
import { caseReasonFor } from "../src/lib/case-explanations.ts";
import { analysisKey, statusKey, textKey } from "@skolia/shared/keys";
import type { Blob, Entry, Feats, Pronunciation, Recording, Status } from "@skolia/shared/schema";
import { AnnotationId, CardId, DocumentId, LemmaId, ReadingListId, Timestamp, UserId } from "@skolia/shared/schemas";

type Deps = Parameters<typeof createApp>[0];
type StoredDocument = Awaited<ReturnType<Deps["documents"]["list"]>>["items"][number];
type StoredBlob = NonNullable<Awaited<ReturnType<Deps["blobs"]["get"]>>>;

const DIST = join(import.meta.dirname, "..", "dist");
const FIXTURES = join(import.meta.dirname, "fixtures");

const NOW = new Date("2026-11-09T10:00:00Z");
const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const dictionary = JSON.parse(fixture("lalka.lexicon.json").toString("utf8")) as {
  entries: Record<string, Entry>;
  lookup: Record<string, string>;
  feats: Feats[];
  pronunciations: Record<string, Pronunciation[]>;
  recordings: Record<string, Recording[]>;
};
const analysis = JSON.parse(fixture("lalka.analysis.json").toString("utf8")) as Blob;
const text = fixture("lalka.txt").toString("utf8");

export const LALKA = DocumentId.parse("121e58375c32bad22cee4888347e0b0003e5594199043db745303749a87c988c");

export const user: User = {
  id: UserId.parse("user-1"),
  name: "Ada Lovelace",
  email: "ada@example.com",
  image: null,
  roles: [],
};

const SKOLIA = UserId.parse("skolia");

/** Where the recordings are. */
export const AUDIO = "https://audio.skolia.test/";

/** A recording of each paragraph of Lalka, as curated texts will have. */
const narration: readonly Annotation[] = [...text.trimEnd().matchAll(/[^\n]+/gu)].map((paragraph, n) => ({
  id: AnnotationId.parse(String(n + 1).repeat(64)),
  start: paragraph.index,
  end: paragraph.index + paragraph[0].length,
  kind: "audio",
  data: { url: `${AUDIO}lalka-${n + 1}.wav` },
  licence: "public-domain",
  author: null,
  source: null,
  addedAt: Timestamp.parse("2026-11-07T10:00:00.000Z"),
}));

/** Recordings shorter than a paragraph: single words, two on one line, a phrase over a line
 * break, and a word of that phrase on its own. */
export const shortAudio: readonly Annotation[] = ["roku", "1878", "Stefano", "warszawscy kupcy", "jadłodajni", "kupcy"].map((words, n) => {
  const start = text.indexOf(words);
  if (start < 0) throw new Error(`no ${words} in Lalka`);
  return {
    id: AnnotationId.parse(String.fromCharCode(97 + n).repeat(64)),
    start,
    end: start + words.length,
    kind: "audio",
    data: { url: `${AUDIO}word-${n + 1}.wav` },
    licence: "public-domain",
    author: null,
    source: null,
    addedAt: Timestamp.parse("2026-11-07T10:00:00.000Z"),
  };
});

/** Half a minute of silence, as an 8 kHz, 8-bit mono WAV. */
function silence(): Buffer {
  const samples = 8000 * 30;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples, 40);
  return Buffer.concat([header, Buffer.alloc(samples, 0x80)]);
}
const ANALYSIS = analysisKey(LALKA, "s2-ac973bfbdb066");

const lalka: StoredDocument = {
  status: null,
  id: LALKA,
  title: "Lalka",
  lang: "pl",
  importedAt: Timestamp.parse("2026-11-07T09:58:00.000Z"),
  words: 72,
  user: user.id,
  importerName: user.name,
  visibility: "public",
  licence: "public-domain",
  author: "Bolesław Prus",
  source: "https://wolnelektury.pl/katalog/lektura/lalka-tom-pierwszy.html",
  tags: { level: "C1" },
};

function stored(n: number, fields: Partial<StoredDocument>): StoredDocument {
  return { ...lalka, id: DocumentId.parse(String(n).repeat(64)), user: SKOLIA, importerName: "skolia", ...fields };
}

const PETIT_PRINCE = stored(1, {
  title: "Le Petit Prince, chapitre I",
  lang: "fr",
  licence: "cc-by-sa-4.0",
  author: "Antoine de Saint-Exupéry",
  words: 412,
  tags: { level: "B1" },
});
const NOTATKI = stored(2, {
  title: "Notatki",
  visibility: "private",
  licence: "cc-by-4.0",
  author: null,
  user: user.id,
  importerName: user.name,
  words: 38,
  tags: {},
});
const PETER_RABBIT = stored(3, {
  title: "The Tale of Peter Rabbit",
  lang: "en",
  author: "Beatrix Potter",
  words: 951,
  tags: { level: "A2" },
});

/** The levels migration 0008 makes. */
const LEVELS = (
  [
    ["A0", "Starter"],
    ["A1", "Beginner"],
    ["A2", "Elementary"],
    ["B1", "Intermediate"],
    ["B2", "Upper intermediate"],
    ["C1", "Advanced"],
    ["C2", "Proficient"],
    ["C3", "Native"],
  ] as const
).map(([value, description]) => ({ kind: "level", value, description }));

/** Explore's list: one of each badge and licence the listing shows. */
const documents: readonly StoredDocument[] = [lalka, PETIT_PRINCE, NOTATKI, PETER_RABBIT];

const statuses: readonly (readonly [DocumentIdType, Status])[] = [
  [
    LALKA,
    {
      state: "ready",
      updated: "2026-11-07T10:00:00.000Z",
      artifacts: { analyzer: "pl/1", analysis: ANALYSIS },
    },
  ],
  [
    PETIT_PRINCE.id,
    {
      state: "ready",
      updated: "2026-11-07T10:00:00.000Z",
      artifacts: {
        analyzer: "fr/1",
        analysis: analysisKey(PETIT_PRINCE.id, "s2-a1"),
      },
    },
  ],
  [NOTATKI.id, { state: "queued", updated: "2026-11-09T09:55:00.000Z" }],
  [PETER_RABBIT.id, { state: "failed", updated: "2026-11-08T10:00:00.000Z", error: "The analyser stopped" }],
];

const JSON_TYPE = "application/json";

/** The blobs as ingest stores them: analyses Brotli-compressed. */
const blobs: ReadonlyMap<string, StoredBlob> = new Map([
  [textKey(LALKA), { body: new Uint8Array(fixture("lalka.txt")), contentType: "text/plain; charset=utf-8" }],
  [ANALYSIS, { body: new Uint8Array(brotliCompressSync(fixture("lalka.analysis.json"))), contentType: JSON_TYPE }],
  ...statuses.map(
    ([id, status]) => [statusKey(id), { body: new TextEncoder().encode(JSON.stringify(status)), contentType: JSON_TYPE }] as const,
  ),
]);

/** The lexicon fixture's entries. */
function entry(lemmaId: LemmaIdType): Entry | null {
  const found = dictionary.entries[dictionary.lookup[lemmaId] ?? lemmaId];
  return found === undefined ? null : { ...found, recordings: dictionary.recordings[`${found.lemma}:${found.upos}`] ?? [] };
}

const featureSets = Object.fromEntries(dictionary.feats.map((feats, id) => [String(id), feats]));

/** The lexicon Worker's (lexicon-api/src/app.ts), on the fixture's Polish entries. */
const lexicon: Lexicon = {
  served: async () => "lex/1",
  byIds: async (_lang, _version, ids) => found(ids.flatMap((id) => entry(id) ?? [])),
  resolve: async (_lang, _version, id) => found([entry(id)].flatMap((value) => value ?? [])),
  formAudio: async (_lang, _version, form, upos) => ({
    pronunciations: dictionary.pronunciations[`${form}:${upos}`] ?? [],
    recordings: dictionary.recordings[`${form}:${upos}`] ?? [],
  }),
  byLemma: async (_lang, _version, lemma) =>
    found(
      Object.keys(dictionary.entries).flatMap((id) => (dictionary.entries[id]?.lemma === lemma ? (entry(LemmaId.parse(id)) ?? []) : [])),
    ),
};

function found(entries: readonly Entry[]): Found {
  return { entries, related: [], incoming: new Map(), featureSets };
}

/** What forward hands requests to: the API's app or the lexicon's. */
type Requestable = { request(url: string, init: RequestInit): Response | Promise<Response> };

/** A cloze card for a token of the text, as the word sheet makes it. */
function clozeOf(sentence: number, index: number): Cloze {
  const found = analysis.sentences[sentence];
  const token = found?.tokens[index];
  if (!found || !token) throw new Error(`no token ${sentence}.${index}`);
  return {
    documentId: LALKA,
    ...blankOut({ start: found.start, text: text.slice(found.start, found.end) }, token),
    caseReason: caseReasonFor(found.tokens, index),
  };
}

const cards: readonly ScheduledCard[] = [
  {
    id: CardId.parse("00000000-0000-4000-8000-000000000001"),
    lemmaIds: [LemmaId.parse("pl:sklep:NOUN")],
    kind: "recognition",
    isNew: false,
    dueAt: Timestamp.parse("2026-11-09T08:00:00.000Z"),
    data: {},
  },
  {
    id: CardId.parse("00000000-0000-4000-8000-000000000002"),
    lemmaIds: [LemmaId.parse("pl:wojna:NOUN")],
    kind: "production",
    isNew: true,
    dueAt: Timestamp.parse("2026-11-09T08:00:00.000Z"),
    data: {},
  },
  // kolację, in "schodzą się na kolację": na takes the accusative for where to
  {
    id: CardId.parse("00000000-0000-4000-8000-000000000003"),
    lemmaIds: [LemmaId.parse("pl:kolacja:NOUN")],
    kind: "cloze",
    isNew: true,
    dueAt: Timestamp.parse("2026-11-09T08:00:00.000Z"),
    data: clozeOf(1, 14),
  },
];

/** The cards as the list of them has them, newest first: one due in days, a lemma's two new, one
 * whose word is known, and the cloze card due. */
const listedCards: readonly Card[] = [
  listed(cards[2]!, "2026-11-08T08:00:00.000Z", { scheduleStatus: "learning", dueAt: "2026-11-09T09:00:00.000Z", scheduledDays: 0 }),
  listed(cards[1]!, "2026-11-07T08:00:00.000Z", { scheduleStatus: "new", dueAt: "2026-11-09T08:00:00.000Z", scheduledDays: 0 }),
  listed(
    { ...cards[1]!, id: CardId.parse("00000000-0000-4000-8000-000000000005"), kind: "recognition", data: {} },
    "2026-11-07T08:00:00.000Z",
    {
      scheduleStatus: "new",
      dueAt: "2026-11-09T08:00:00.000Z",
      scheduledDays: 0,
    },
  ),
  listed(cards[0]!, "2026-11-06T08:00:00.000Z", { scheduleStatus: "review", dueAt: "2026-11-13T08:00:00.000Z", scheduledDays: 4 }),
  listed(
    { ...cards[0]!, id: CardId.parse("00000000-0000-4000-8000-000000000004"), kind: "production", data: {} },
    "2026-11-06T08:00:00.000Z",
    { scheduleStatus: "review", dueAt: "2026-12-01T08:00:00.000Z", scheduledDays: 25 },
    "known",
  ),
];

/** A card to review as the list of cards has it, last answered the day before NOW unless it's new. */
function listed(
  { isNew: _, ...card }: ScheduledCard,
  createdAt: string,
  { scheduleStatus, dueAt, scheduledDays }: { scheduleStatus: Card["scheduleStatus"]; dueAt: string; scheduledDays: number },
  state: Card["state"] = "learning",
): Card {
  return {
    ...card,
    state,
    createdAt: Timestamp.parse(createdAt),
    scheduleStatus,
    dueAt: Timestamp.parse(dueAt),
    scheduledDays,
    lastReviewedAt: scheduleStatus === "new" ? null : Timestamp.parse("2026-11-08T09:00:00.000Z"),
  };
}

/** The API's ports, in memory, for one test. Writes the pages make are accepted and
 * forgotten, except settings. */
function deps(signedIn: boolean, annotations: readonly Annotation[]): Deps {
  const visible = (viewer: UserIdType | null) =>
    documents
      .filter((d) => d.visibility === "public" || d.user === viewer)
      .map((d) => ({ ...d, status: statuses.find(([id]) => id === d.id)?.[1] ?? null }));
  let settings: Settings = { newLemmasPerDay: 10 };
  let kept = listedCards;
  let readingLists: readonly ReadingList[] = [
    "To read",
    "Reading now",
    "Finished",
    "Book club",
    "French short stories",
    "Polish classics",
    "Weekend reading",
    "Stories with audio",
    "Travel",
    "Poetry",
    "For a rainy day",
  ].map((name, index) => ({
    id: ReadingListId.parse(index + 1),
    name,
    documentsCount: 0,
    createdAt: Timestamp.parse(NOW.toISOString()),
  }));
  let nextListId = readingLists.length + 1;
  let memberships: readonly {
    readonly listId: ReadingListIdType;
    readonly documentId: DocumentIdType;
    readonly createdAt: ReturnType<typeof Timestamp.parse>;
  }[] = [
    { listId: readingLists[0]!.id, documentId: PETIT_PRINCE.id, createdAt: Timestamp.parse(NOW.toISOString()) },
    { listId: readingLists[1]!.id, documentId: LALKA, createdAt: Timestamp.parse(NOW.toISOString()) },
    { listId: readingLists[3]!.id, documentId: PETIT_PRINCE.id, createdAt: Timestamp.parse(NOW.toISOString()) },
    { listId: readingLists[3]!.id, documentId: LALKA, createdAt: Timestamp.parse(NOW.toISOString()) },
  ];
  const withCounts = () =>
    readingLists.map((list) => ({ ...list, documentsCount: memberships.filter((item) => item.listId === list.id).length }));
  return {
    auth: {
      handle: async () => new Response(null, { status: 404 }),
      user: async () => (signedIn ? user : null),
    },
    users: {
      due: async (_userId, lang: Lang) => ({ cards: lang === "pl" ? [...cards] : [], newLeft: 4 }),
      counts: async () => [{ lang: "pl", due: 2, new: 6 }],
      review: async (_userId, request) => ({
        kind: "reviewed",
        cardId: request.cardId,
        dueAt: Timestamp.parse("2026-11-10T10:00:00.000Z"),
      }),
      makeCard: async () => ({ kind: "made", cardId: CardId.parse("00000000-0000-4000-8000-000000000009") }),
      cards: async (_userId, listing) => ({
        items:
          "documentId" in listing
            ? []
            : "lemmaId" in listing
              ? kept.filter((c) => c.lemmaIds.includes(listing.lemmaId))
              : listing.lang === "pl"
                ? kept
                : [],
        next: null,
      }),
      setWordState: async () => true,
      deleteCard: async (_userId, cardId) => {
        const had = kept.some((c) => c.id === cardId);
        kept = kept.filter((c) => c.id !== cardId);
        return had;
      },
      settings: async () => settings,
      setSettings: async (_userId, next) => {
        settings = next;
      },
      readingLists: async () => withCounts(),
      createReadingList: async (_userId, name, createdAt) => {
        const id = ReadingListId.parse(nextListId++);
        readingLists = [...readingLists, { id, name, createdAt, documentsCount: 0 }];
        return id;
      },
      renameReadingList: async (_userId, id, name) => {
        readingLists = readingLists.map((list) => (list.id === id ? { ...list, name } : list));
        return true;
      },
      deleteReadingList: async (_userId, id) => {
        readingLists = readingLists.filter((list) => list.id !== id);
        memberships = memberships.filter((item) => item.listId !== id);
        return true;
      },
      readingListMemberships: async (_userId, id) => memberships.filter((item) => item.documentId === id).map((item) => item.listId),
      addDocumentToReadingList: async (_userId, listId, documentId, _lang, createdAt) => {
        if (!readingLists.some((list) => list.id === listId)) return false;
        if (!memberships.some((item) => item.listId === listId && item.documentId === documentId)) {
          memberships = [...memberships, { listId, documentId, createdAt }];
        }
        return true;
      },
      removeDocumentFromReadingList: async (_userId, listId, documentId) => {
        if (!readingLists.some((list) => list.id === listId)) return false;
        memberships = memberships.filter((item) => item.listId !== listId || item.documentId !== documentId);
        return true;
      },
      readingListDocuments: async (_userId, listId, lang) => ({
        items: memberships.filter(
          (item) => item.listId === listId && (lang === undefined || documents.find((doc) => doc.id === item.documentId)?.lang === lang),
        ),
        next: null,
      }),
      position: async () => null,
      setPosition: async () => {},
      take: async () => ({ kind: "taken" }),
    },
    roles: { of: async () => [], grants: async () => false },
    importRate: { limit: 20, windowSeconds: 3600 },
    lexicon: {
      entries: async (ids) => ({ entries: ids.flatMap((id) => entry(id) ?? []), featureSets: { pl: featureSets } }),
    },
    documents: {
      // One page: there are only a few
      list: async (viewer, { tags, lang, title, mine }) => ({
        items: visible(viewer).filter(
          (d) =>
            (!mine || d.user === viewer) &&
            (lang === undefined || d.lang === lang) &&
            (title === undefined || d.title.toLowerCase().includes(title.toLowerCase())) &&
            matchesTags(d.tags, tags),
        ),
        next: null,
      }),
      tags: async () => ({ items: LEVELS, next: null }),
      known: async (wanted) => LEVELS.filter((l) => wanted.some((w) => w.kind === l.kind && w.value === l.value)),
      visible: async (id, viewer) => visible(viewer).find((d) => d.id === id) ?? null,
      visibleAll: async (ids, viewer) =>
        new Map(
          visible(viewer)
            .filter((d) => ids.includes(d.id))
            .map((d) => [d.id, d] as const),
        ),
      has: async (id) => documents.some((d) => d.id === id),
      setStatus: async () => {},
      add: async () => {},
      update: async () => {},
      remove: async () => {},
      // One page: there are only a few
      annotations: async (id) => ({ items: id === LALKA ? annotations : [], next: null }),
      annotate: async () => ({ kind: "full" }),
      unannotate: async () => false,
    },
    blobs: {
      get: async (key) => blobs.get(key) ?? null,
      put: async () => {},
    },
    queue: {
      start: async () => {},
      jobs: async (lang) => INGEST[lang],
    },
    ingestHistory: { recent: async () => INGEST_HISTORY },
    version: "dev",
    reader: { lexiconConcurrency: 6 },
    now: () => NOW,
  };
}

/** NOW less some seconds */
const before = (seconds: number) => Timestamp.parse(new Date(NOW.getTime() - seconds * 1000).toISOString());

type IngestJobs = NonNullable<Awaited<ReturnType<Deps["queue"]["jobs"]>>>;
type IngestJobRecord = Awaited<ReturnType<Deps["ingestHistory"]["recent"]>>[number];

/** Polish analysing someone's private text with Lalka waiting, French starting, English idle */
const INGEST: Readonly<Record<Lang, IngestJobs | null>> = {
  en: null,
  fr: { loading: true, running: [], waiting: [], startedAt: before(38), jobs: [] },
  pl: {
    loading: false,
    running: [NOTATKI.id],
    waiting: [LALKA],
    startedAt: before(300),
    jobs: [
      {
        id: "a1",
        doc: NOTATKI.id,
        lang: "pl",
        acceptedAt: before(130),
        startedAt: before(52),
        stage: "analysing",
        stageStartedAt: before(51),
        chars: 4210,
        words: 702,
        stages: [{ stage: "reading", ms: 140 }],
      },
      {
        id: "a2",
        doc: LALKA,
        lang: "pl",
        acceptedAt: before(20),
        startedAt: null,
        stage: null,
        stageStartedAt: null,
        chars: null,
        words: null,
        stages: [],
      },
    ],
  },
};

/** Lalka analysed, a private text too long, a French one whose container stopped mid-job,
 * and Le Petit Prince bundled again from its stored analysis */
const INGEST_HISTORY: readonly IngestJobRecord[] = [
  {
    id: "f1",
    doc: LALKA,
    lang: "pl",
    image: "skolia-ingest-pl:9a2b7f1",
    acceptedAt: before(400),
    startedAt: before(360),
    result: {
      finishedAt: before(354),
      outcome: "ready",
      error: null,
      chars: 412,
      words: 72,
      stages: [
        { stage: "reading", ms: 90 },
        { stage: "analysing", ms: 4310 },
        { stage: "bundling", ms: 820 },
        { stage: "compressing-analysis", ms: 310 },
        { stage: "uploading-analysis", ms: 120 },
        { stage: "compressing-bundle", ms: 260 },
        { stage: "uploading-bundle", ms: 95 },
      ],
    },
  },
  {
    id: "f2",
    doc: NOTATKI.id,
    lang: "pl",
    image: "skolia-ingest-pl:9a2b7f1",
    acceptedAt: before(1900),
    startedAt: before(1880),
    result: {
      finishedAt: before(1879),
      outcome: "failed",
      error: "text is longer than 200000 characters",
      chars: 210_400,
      words: 33_012,
      stages: [{ stage: "reading", ms: 610 }],
    },
  },
  {
    id: "f3",
    doc: PETIT_PRINCE.id,
    lang: "fr",
    image: "skolia-ingest-fr:2b8e113",
    acceptedAt: before(3700),
    startedAt: before(3650),
    result: null,
  },
  {
    id: "f4",
    doc: PETIT_PRINCE.id,
    lang: "fr",
    image: "skolia-ingest-fr:4c1d9e0",
    acceptedAt: before(7400),
    startedAt: before(7340),
    result: {
      finishedAt: before(7338),
      outcome: "ready",
      error: null,
      chars: 2380,
      words: 412,
      stages: [
        { stage: "reading", ms: 70 },
        { stage: "loading-analysis", ms: 400 },
        { stage: "bundling", ms: 1100 },
        { stage: "compressing-bundle", ms: 290 },
        { stage: "uploading-bundle", ms: 110 },
      ],
    },
  },
];

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

/** Hands the request to the app. The browser adds Accept-Encoding after interception, so
 * it's added here; a Brotli body is decompressed here, as the browser would, since a
 * fulfilled response's body is taken as already decoded. */
async function forward(route: Route, app: Requestable, failed: string[], prefix = ""): Promise<void> {
  const request = route.request();
  const body = request.postDataBuffer();
  const url = new URL(request.url());
  url.pathname = url.pathname.slice(prefix.length);
  const response = await app.request(url.href, {
    method: request.method(),
    headers: { "accept-encoding": "gzip, deflate, br", ...(await request.allHeaders()) },
    ...(body ? { body: new Uint8Array(body) } : {}),
  });
  const { pathname } = new URL(request.url());
  const missingEntry = response.status === 404 && pathname.startsWith("/api/lexicon/v1/entries/");
  if (response.status >= 400 && response.status !== 401 && !missingEntry) {
    failed.push(`${request.method()} ${pathname}: ${response.status}`);
  }
  const headers = Object.fromEntries(response.headers);
  const raw = Buffer.from(await response.arrayBuffer());
  const decoded = headers["content-encoding"] === "br" ? brotliDecompressSync(raw) : raw;
  delete headers["content-encoding"];
  delete headers["content-length"];
  await route.fulfill({ status: response.status, headers, body: decoded });
}

/** Serves the reader and the API to the page; returns the API requests that failed
 * except expected sign-in and missing-entry responses. */
export async function serve(
  page: Page,
  { signedIn, annotations = narration }: { signedIn: boolean; annotations?: readonly Annotation[] },
): Promise<string[]> {
  const app = createApp(deps(signedIn, annotations));
  const lexiconApp = createLexiconApp({ lexicon, checkResponses: true });
  const failed: string[] = [];
  await page.clock.setFixedTime(NOW);
  // The review's shuffle (lib/review.ts) keeps the cards in the order the API sends them
  // when every draw is just under 1, so the tests know which card comes when
  await page.addInitScript(() => {
    Math.random = () => 1 - Number.EPSILON;
  });
  await page.route("https://skolia.test/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith("/api/lexicon/")) return forward(route, lexiconApp, failed, "/api/lexicon");
    if (pathname.startsWith("/api/")) return forward(route, app, failed);
    const file = pathname === "/" ? "index.html" : pathname.slice(1);
    const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
    await route.fulfill({ status: 200, contentType: type, body: readFileSync(join(DIST, file)) });
  });
  await page.route(`${AUDIO}**`, (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: silence() }));
  return failed;
}
