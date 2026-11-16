// The reader as built (dist/) and the API's own Hono app (createApp), both served to the
// page by page.route. The app runs on in-memory ports typed by its Deps, so the
// screenshots need no Worker, database or ingest, and a change to a port or a route's
// response fails tsc -p screenshots. The text is the start of Prus's Lalka (public
// domain), its analysis and bundle as ingest stored them, with a recording of each
// paragraph: silence, served from AUDIO.
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import type { Page, Route } from "@playwright/test";
import { createApp } from "@skolia/api/app";
import {
  blankOut,
  matchesTags,
  type Annotation,
  type Card,
  type Cloze,
  type DocumentId as DocumentIdType,
  type Lang,
  type LemmaId as LemmaIdType,
  type LexiconEntry,
  type ScheduledCard,
  type Settings,
  type User,
  type UserId as UserIdType,
} from "@skolia/shared/api";
import { LANGUAGES } from "@skolia/shared/lang";
import { partKey, statusKey, textKey } from "@skolia/shared/keys";
import type { Blob, Bundle, Status } from "@skolia/shared/schema";
import { AnnotationId, CardId, DocumentId, LemmaId, Timestamp, UserId } from "@skolia/shared/schemas";

type Deps = Parameters<typeof createApp>[0];
type StoredDocument = Awaited<ReturnType<Deps["documents"]["list"]>>["items"][number];
type StoredBlob = NonNullable<Awaited<ReturnType<Deps["blobs"]["get"]>>>;
type StoredReading = Awaited<ReturnType<Deps["users"]["readingList"]>>["items"][number];

const DIST = join(import.meta.dirname, "..", "dist");
const FIXTURES = join(import.meta.dirname, "fixtures");

const NOW = new Date("2026-11-09T10:00:00Z");
const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const bundle = JSON.parse(fixture("lalka.bundle.json").toString("utf8")) as Bundle;
const analysis = JSON.parse(fixture("lalka.analysis.json").toString("utf8")) as Blob;
const text = fixture("lalka.txt").toString("utf8");

export const LALKA = DocumentId.parse("121e58375c32bad22cee4888347e0b0003e5594199043db745303749a87c988c");

export const user: User = {
  id: UserId.parse("user-1"),
  name: "Ada Lovelace",
  email: "ada@example.com",
  image: null,
  type: "standard",
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

/** Recordings shorter than a paragraph: single words, two on one line, and a phrase over a line break. */
export const shortAudio: readonly Annotation[] = ["roku", "1878", "Stefano", "warszawscy kupcy", "jadłodajni"].map((words, n) => {
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
const ANALYSIS = partKey(LALKA, "analysis", "s2-ac973bfbdb066");
const BUNDLE = partKey(LALKA, "bundle", "b1-v2-ac973bfbdb066-l5da30b8a5747");

const lalka: StoredDocument = {
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
  [LALKA, { state: "ready", updated: "2026-11-07T10:00:00.000Z", analysis: ANALYSIS, bundle: BUNDLE }],
  [PETIT_PRINCE.id, { state: "ready", updated: "2026-11-07T10:00:00.000Z" }],
  [NOTATKI.id, { state: "queued", updated: "2026-11-09T09:55:00.000Z" }],
  [PETER_RABBIT.id, { state: "failed", updated: "2026-11-08T10:00:00.000Z", error: "The analyser stopped" }],
];

/** The user's reading list: Lalka being read, Le Petit Prince to read. */
const readingList: readonly StoredReading[] = [
  {
    documentId: LALKA,
    status: "reading",
    addedAt: Timestamp.parse("2026-11-07T10:00:00.000Z"),
    updatedAt: Timestamp.parse("2026-11-08T18:00:00.000Z"),
  },
  {
    documentId: PETIT_PRINCE.id,
    status: "to-read",
    addedAt: Timestamp.parse("2026-11-08T09:00:00.000Z"),
    updatedAt: Timestamp.parse("2026-11-08T09:00:00.000Z"),
  },
];

const JSON_TYPE = "application/json";

/** The blobs as ingest stores them: analyses and bundles Brotli-compressed. */
const blobs: ReadonlyMap<string, StoredBlob> = new Map([
  [textKey(LALKA), { body: new Uint8Array(fixture("lalka.txt")), contentType: "text/plain; charset=utf-8" }],
  [ANALYSIS, { body: new Uint8Array(brotliCompressSync(fixture("lalka.analysis.json"))), contentType: JSON_TYPE }],
  [BUNDLE, { body: new Uint8Array(brotliCompressSync(fixture("lalka.bundle.json"))), contentType: JSON_TYPE }],
  ...statuses.map(
    ([id, status]) => [statusKey(id), { body: new TextEncoder().encode(JSON.stringify(status)), contentType: JSON_TYPE }] as const,
  ),
]);

function entry(lemmaId: LemmaIdType): LexiconEntry | null {
  const found = bundle.entries[lemmaId];
  if (!found) return null;
  return {
    lemmaId,
    lemma: found.lemma,
    upos: found.upos,
    senses: found.senses,
    relations: found.relations,
    pronunciations: [],
    paradigms: found.paradigms,
  };
}

const featureSets = Object.fromEntries(bundle.feats.map((feats, id) => [String(id), feats]));

/** A cloze card for a token of the text, as the word sheet makes it. */
function clozeOf(sentence: number, index: number): Cloze {
  const found = analysis.sentences[sentence];
  const token = found?.tokens[index];
  if (!found || !token) throw new Error(`no token ${sentence}.${index}`);
  return {
    documentId: LALKA,
    ...blankOut({ start: found.start, text: text.slice(found.start, found.end) }, token),
    why: LANGUAGES.pl.explainCase(found.tokens, index)?.text ?? null,
  };
}

const cards: readonly ScheduledCard[] = [
  {
    id: CardId.parse("00000000-0000-4000-8000-000000000001"),
    lemmaId: LemmaId.parse("pl:sklep:NOUN"),
    kind: "recognition",
    isNew: false,
    dueAt: Timestamp.parse("2026-11-09T08:00:00.000Z"),
    cloze: null,
  },
  {
    id: CardId.parse("00000000-0000-4000-8000-000000000002"),
    lemmaId: LemmaId.parse("pl:wojna:NOUN"),
    kind: "production",
    isNew: true,
    dueAt: Timestamp.parse("2026-11-09T08:00:00.000Z"),
    cloze: null,
  },
  // kolację, in "schodzą się na kolację": na takes the accusative for where to
  {
    id: CardId.parse("00000000-0000-4000-8000-000000000003"),
    lemmaId: LemmaId.parse("pl:kolacja:NOUN"),
    kind: "cloze",
    isNew: true,
    dueAt: Timestamp.parse("2026-11-09T08:00:00.000Z"),
    cloze: clozeOf(1, 14),
  },
];

/** The cards as the list of them has them, newest first: one due in days, one new, one
 * whose word is known, and the cloze card due. */
const listedCards: readonly Card[] = [
  listed(cards[2]!, "2026-11-08T08:00:00.000Z", { scheduleStatus: "learning", dueAt: "2026-11-09T09:00:00.000Z", scheduledDays: 0 }),
  listed(cards[1]!, "2026-11-07T08:00:00.000Z", { scheduleStatus: "new", dueAt: "2026-11-09T08:00:00.000Z", scheduledDays: 0 }),
  listed(cards[0]!, "2026-11-06T08:00:00.000Z", { scheduleStatus: "review", dueAt: "2026-11-13T08:00:00.000Z", scheduledDays: 4 }),
  listed(
    { ...cards[0]!, id: CardId.parse("00000000-0000-4000-8000-000000000004"), kind: "production" },
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
  const visible = (viewer: UserIdType | null) => documents.filter((d) => d.visibility === "public" || d.user === viewer);
  let settings: Settings = { newLemmasPerDay: 10, newFormsPerDay: 5, formsWithWords: true };
  let kept = listedCards;
  return {
    auth: {
      handle: async () => new Response(null, { status: 404 }),
      user: async () => (signedIn ? user : null),
    },
    users: {
      due: async (_userId, lang: Lang, _now, _dayStart, _limit, group) => ({
        cards: lang === "pl" ? cards.filter((c) => group === undefined || (c.kind === "cloze") === (group === "forms")) : [],
        newLeft: { words: 4, forms: 3 },
      }),
      counts: async () => [{ lang: "pl", words: { due: 2, new: 4 }, forms: { due: 0, new: 2 } }],
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
              ? kept.filter((c) => c.lemmaId === listing.lemmaId)
              : listing.lang === "pl"
                ? kept
                : [],
        next: null,
      }),
      setCardState: async () => true,
      deleteCard: async (_userId, cardId) => {
        const had = kept.some((c) => c.id === cardId);
        kept = kept.filter((c) => c.id !== cardId);
        return had;
      },
      settings: async () => settings,
      setSettings: async (_userId, next) => {
        settings = next;
      },
      position: async () => null,
      setPosition: async () => {},
      reading: async (_userId, id) => {
        const found = readingList.find((r) => r.documentId === id);
        return found ? { status: found.status, addedAt: found.addedAt, updatedAt: found.updatedAt } : null;
      },
      setReading: async (_userId, _id, _lang, status) => ({
        status,
        addedAt: Timestamp.parse(NOW.toISOString()),
        updatedAt: Timestamp.parse(NOW.toISOString()),
      }),
      removeReading: async () => {},
      // One page: there are only a few
      readingList: async (_userId, { status, lang }) => ({
        items: readingList.filter(
          (r) => r.status === status && (lang === undefined || documents.find((d) => d.id === r.documentId)?.lang === lang),
        ),
        next: null,
      }),
    },
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
      send: async () => {},
      jobs: async () => ({ loading: false, running: [], waiting: [NOTATKI.id] }),
    },
    version: "screenshots",
    now: () => NOW,
  };
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

/** Hands the request to the app. The browser adds Accept-Encoding after interception, so
 * it's added here; a Brotli body is decompressed here, as the browser would, since a
 * fulfilled response's body is taken as already decoded. */
async function forward(route: Route, app: ReturnType<typeof createApp>, failed: string[]): Promise<void> {
  const request = route.request();
  const body = request.postDataBuffer();
  const response = await app.request(request.url(), {
    method: request.method(),
    headers: { "accept-encoding": "gzip, deflate, br", ...(await request.allHeaders()) },
    ...(body ? { body: new Uint8Array(body) } : {}),
  });
  const { pathname } = new URL(request.url());
  if (response.status >= 400 && response.status !== 401) failed.push(`${request.method()} ${pathname}: ${response.status}`);
  const headers = Object.fromEntries(response.headers);
  const raw = Buffer.from(await response.arrayBuffer());
  const decoded = headers["content-encoding"] === "br" ? brotliDecompressSync(raw) : raw;
  delete headers["content-encoding"];
  delete headers["content-length"];
  await route.fulfill({ status: response.status, headers, body: decoded });
}

/** Serves the reader and the API to the page; returns the API requests that failed
 * (other than 401s), for the test to check are none. */
export async function serve(
  page: Page,
  { signedIn, annotations = narration }: { signedIn: boolean; annotations?: readonly Annotation[] },
): Promise<string[]> {
  const app = createApp(deps(signedIn, annotations));
  const failed: string[] = [];
  await page.clock.setFixedTime(NOW);
  await page.route("https://skolia.test/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith("/api/")) return forward(route, app, failed);
    const file = pathname === "/" ? "index.html" : pathname.slice(1);
    const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
    await route.fulfill({ status: 200, contentType: type, body: readFileSync(join(DIST, file)) });
  });
  await page.route(`${AUDIO}**`, (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: silence() }));
  return failed;
}
