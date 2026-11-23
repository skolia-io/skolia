// The API's routes. Each extracts and validates a request's input, calls a controller
// (src/controllers/), which takes data and returns a Result, and sends that.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { Context, TypedResponse } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { JSONParsed } from "hono/utils/types";
import * as z from "zod";
import { ANNOTATION_BATCH, MAX_TEXT_LENGTH, type ApiError, type Config, type Identity, type User, type Version } from "@skolia/shared/api";
import * as schemas from "@skolia/shared/schemas";
import * as annotations from "./controllers/annotations.ts";
import * as cards from "./controllers/cards.ts";
import * as documents from "./controllers/documents.ts";
import * as ingest from "./controllers/ingest.ts";
import * as positions from "./controllers/positions.ts";
import * as readingLists from "./controllers/reading-lists.ts";
import { fail, ok, type BlobResult, type Failed, type NotModified, type Result } from "./controllers/result.ts";
import { log } from "@skolia/util/log";
import {
  NOT_SIGNED_IN,
  NO_BODY,
  RETRY_AFTER,
  REDOC_PAGE,
  SCALAR_PAGE,
  SIGNED_IN,
  TAGS,
  badRequest,
  describe,
  error,
  json,
  responses,
  validator,
} from "./openapi.ts";
import type { Deps } from "./ports/index.ts";
import spec from "../openapi.json" with { type: "json" };

const logger = log("api");

// A character is at most 6 bytes in JSON (\uXXXX), plus room for the title. The exact
// character limit is checked after parsing.
const MAX_BODY_BYTES = MAX_TEXT_LENGTH * 6 + 4 * 1024;
const DOCUMENT_ID_MESSAGE = "document id must be 64 lowercase hex characters";
const ANNOTATION_ID_MESSAGE = "annotation id must be 64 lowercase hex characters";
// An annotation's data is a URL or so: room for each of a batch to be 2 KiB, or a few to be big
const MAX_ANNOTATION_BATCH_BYTES = 2 * 1024 * ANNOTATION_BATCH;
/** /api/config changes only with a deploy: a few minutes' copy is current enough. */
const CONFIG_CACHE = "public, max-age=300";

export type AppType = ReturnType<typeof createApp>;

/** A route for the signed-in user, in the spec. */
function mine(tag: string, summary: string, description?: string) {
  return describe({ tags: [tag], summary, ...(description === undefined ? {} : { description }), security: SIGNED_IN });
}

/** A route anyone may call, which shows the signed-in user more. */
function anyone(tag: string, summary: string, description?: string) {
  return describe({ tags: [tag], summary, ...(description === undefined ? {} : { description }), security: [{}, ...SIGNED_IN] });
}

const JSON_ERROR = { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } };

/** An analysis: stored Brotli-compressed, and sent that way. */
const PART_RESPONSES = {
  200: { description: "The JSON, with Content-Encoding: br", content: { "application/json": { schema: { type: "object" } } } },
  304: { description: "The client's copy is current" },
  404: { description: "No such document, or it has no such analysis", content: JSON_ERROR },
  406: { description: "The client doesn't accept Brotli", content: JSON_ERROR },
} as const;

export function createApp(deps: Deps) {
  // Stop reading an oversized body early instead of parsing it and then refusing it
  const limit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: `text is longer than ${MAX_TEXT_LENGTH} characters` } satisfies ApiError, 413),
  });

  const annotationLimit = bodyLimit({
    maxSize: MAX_ANNOTATION_BATCH_BYTES,
    onError: (c) => c.json({ error: `a batch of annotations is at most ${MAX_ANNOTATION_BATCH_BYTES} bytes` } satisfies ApiError, 413),
  });

  /** The controller's result for the signed-in user, or 401. */
  async function signedIn<R extends Result>(
    c: Context,
    run: (user: Identity) => Promise<R>,
    message = "not signed in",
  ): Promise<Sent<R | Failed<401>>> {
    const user = await deps.auth.user(c.req.raw.headers);
    return send<R | Failed<401>>(c, user ? await run(user) : fail(401, message));
  }

  const responds = (specs: Parameters<typeof responses>[0]) => responses(specs, deps.checkResponses ?? false);

  const app = new Hono()
    .onError((error, c) => {
      if (error instanceof HTTPException && error.status < 500) {
        return c.json({ error: error.message } satisfies ApiError, error.status);
      }
      logger.error("request failed", { method: c.req.method, path: c.req.path, error });
      return c.json({ error: "internal error" } satisfies ApiError, 500);
    })
    .get(
      "/api/version",
      describe({ tags: [TAGS.account], summary: "The deployed version", security: [] }),
      responds({ 200: json(schemas.Version, "The version, from git describe") }),
      async (c) => c.json({ version: deps.version } satisfies Version, 200),
    )
    .get(
      "/api/config",
      describe({ tags: [TAGS.account], summary: "What the reader is set to do in this deployment", security: [] }),
      responds({ 200: json(schemas.Config, "The config, which changes only with a deploy") }),
      async (c) => c.json({ reader: deps.reader } satisfies Config, 200, { "cache-control": CONFIG_CACHE }),
    )
    .on(["GET", "POST"], "/api/auth/*", describe({ hide: true }), (c) => deps.auth.handle(c.req.raw))
    .get("/api/openapi.json", describe({ hide: true }), (c) => c.json({ ...spec, info: { ...spec.info, version: deps.version } }, 200))
    .get("/api/docs", describe({ hide: true }), (c) => c.redirect("/api/scalar", 302))
    .get("/api/scalar", describe({ hide: true }), (c) => c.html(SCALAR_PAGE))
    .get("/api/redoc", describe({ hide: true }), (c) => c.html(REDOC_PAGE))
    .get(
      "/api/me",
      mine(TAGS.account, "The signed-in user", "With the roles they're bound to; someone who signed up has none."),
      responds({ 200: json(schemas.User, "The user"), 401: NOT_SIGNED_IN }),
      (c) => signedIn(c, async (user) => ok({ ...user, roles: await deps.roles.of(user.id) } satisfies User)),
    )
    .get(
      "/api/me/cards/counts",
      mine(TAGS.cards, "Cards to review, by language", "dayStart: when the user's day started; today's new cards count from it."),
      validator("query", schemas.CountsQuery, badRequest("dayStart must be an ISO time")),
      responds({
        200: json(z.array(schemas.CardCounts), "Due cards, and new cards that would come up today, for each language with words"),
        401: NOT_SIGNED_IN,
      }),
      (c) => signedIn(c, (user) => cards.counts(deps, user, c.req.valid("query").dayStart)),
    )
    .get(
      "/api/me/cards/due",
      mine(
        TAGS.cards,
        "Cards to review now",
        "Cards due now, then new cards: those whose words are all started, and those of as many new words as are left of today's allowance. A card is reviewed while one of its words is being learnt.",
      ),
      validator("query", schemas.DueQuery, badRequest("lang must be a language and dayStart an ISO time")),
      responds({ 200: json(schemas.Due, "The cards, with their lexicon entries"), 401: NOT_SIGNED_IN }),
      (c) => {
        const { lang, dayStart } = c.req.valid("query");
        return signedIn(c, (user) => cards.due(deps, user, lang, dayStart));
      },
    )
    .post(
      "/api/me/reviews",
      mine(TAGS.cards, "Review a card", "The review's id is the client's, so a retried review isn't counted twice."),
      validator("json", schemas.ReviewRequest, badRequest()),
      responds({
        200: json(schemas.Reviewed, "When the card is due next"),
        400: error("The review is in the future"),
        401: NOT_SIGNED_IN,
        404: error("No such card"),
        409: error("The review's id was used for another review"),
      }),
      (c) => signedIn(c, (user) => cards.review(deps, user, c.req.valid("json"))),
    )
    .get(
      "/api/me/cards",
      mine(
        TAGS.cards,
        "A page of the user's cards",
        "A language's (lang) or a word's (lemmaId), newest first; or a text's cloze cards (documentId), in the order of the text. One of the three, and a cursor the same kind of list gave. A card's state is its word's.",
      ),
      validator("query", schemas.CardsQuery, badRequest()),
      responds({
        200: json(schemas.page(schemas.Card), "A page of cards"),
        400: error("Not one of lang, lemmaId and documentId, or another list's cursor"),
        401: NOT_SIGNED_IN,
      }),
      (c) => signedIn(c, (user) => cards.cards(deps, user, c.req.valid("query"))),
    )
    .post(
      "/api/me/cards",
      mine(
        TAGS.cards,
        "Make a card",
        "A word's recognition or production card, one of each per word; or a cloze card, a sentence from a text the user sees with the word blanked out, one per blank. Adds the word, learning, if the user hadn't it.",
      ),
      validator("json", schemas.NewCard, badRequest()),
      responds({
        200: json(schemas.CardMade, "The word had a card of the kind, or the sentence and word had one"),
        201: json(schemas.CardMade, "A new card"),
        401: NOT_SIGNED_IN,
        404: error("No such document"),
        409: error("The user has as many cards as they may"),
      }),
      (c) => signedIn(c, (user) => cards.makeCard(deps, user, c.req.valid("json"))),
    )
    .patch(
      "/api/me/words/:lemmaId",
      mine(
        TAGS.cards,
        "Change a word's state",
        "A word is one the user has cards of. known takes its cards out of reviews; learning puts them back where each was in its schedule.",
      ),
      validator("param", z.object({ lemmaId: schemas.LemmaId }), badRequest()),
      validator("json", schemas.WordChange, badRequest()),
      responds({ 204: NO_BODY, 401: NOT_SIGNED_IN, 404: error("The user has no cards of the word") }),
      (c) => signedIn(c, (user) => cards.setWordState(deps, user, c.req.valid("param").lemmaId, c.req.valid("json").state)),
    )
    .delete(
      "/api/me/cards/:cardId",
      mine(TAGS.cards, "Delete a card", "A card of any kind, with its reviews."),
      validator("param", z.object({ cardId: schemas.CardId }), badRequest("card id must be a UUID")),
      responds({ 204: NO_BODY, 401: NOT_SIGNED_IN, 404: error("No such card") }),
      (c) => signedIn(c, (user) => cards.deleteCard(deps, user, c.req.valid("param").cardId)),
    )
    .get(
      "/api/me/positions/:id",
      mine(TAGS.reading, "Where the user is in a text"),
      validator("param", z.object({ id: schemas.DocumentId }), badRequest(DOCUMENT_ID_MESSAGE)),
      responds({
        200: json(z.object({ position: schemas.StoredPosition.nullable() }), "The position, null if there's none"),
        401: NOT_SIGNED_IN,
      }),
      (c) => signedIn(c, (user) => positions.get(deps, user, c.req.valid("param").id)),
    )
    .put(
      "/api/me/positions/:id",
      mine(TAGS.reading, "Save where the user is in a text", "A position older than the saved one is ignored."),
      validator("param", z.object({ id: schemas.DocumentId }), badRequest(DOCUMENT_ID_MESSAGE)),
      validator("json", schemas.ReadingPosition, badRequest()),
      responds({ 204: NO_BODY, 400: error("The position is in the future"), 401: NOT_SIGNED_IN, 404: error("No such document") }),
      (c) => signedIn(c, (user) => positions.set(deps, user, c.req.valid("param").id, c.req.valid("json"))),
    )
    .get(
      "/api/me/reading-lists",
      mine(TAGS.reading, "The user's reading lists"),
      responds({ 200: json(z.object({ lists: z.array(schemas.ReadingList) }), "Reading lists"), 401: NOT_SIGNED_IN }),
      (c) => signedIn(c, (user) => readingLists.all(deps, user)),
    )
    .post(
      "/api/me/reading-lists",
      mine(TAGS.reading, "Create a reading list"),
      validator("json", schemas.ReadingListName, badRequest()),
      responds({
        200: json(z.object({ id: schemas.ReadingListId }), "Created list"),
        401: NOT_SIGNED_IN,
        409: error("List limit reached"),
      }),
      (c) => signedIn(c, (user) => readingLists.create(deps, user, c.req.valid("json").name)),
    )
    .patch(
      "/api/me/reading-lists/:listId",
      mine(TAGS.reading, "Rename a reading list"),
      validator("param", z.object({ listId: schemas.ReadingListIdParam }), badRequest()),
      validator("json", schemas.ReadingListName, badRequest()),
      responds({ 204: NO_BODY, 401: NOT_SIGNED_IN, 404: error("No such list") }),
      (c) => signedIn(c, (user) => readingLists.rename(deps, user, c.req.valid("param").listId, c.req.valid("json").name)),
    )
    .delete(
      "/api/me/reading-lists/:listId",
      mine(TAGS.reading, "Delete a reading list without deleting its documents"),
      validator("param", z.object({ listId: schemas.ReadingListIdParam }), badRequest()),
      responds({ 204: NO_BODY, 401: NOT_SIGNED_IN, 404: error("No such list") }),
      (c) => signedIn(c, (user) => readingLists.remove(deps, user, c.req.valid("param").listId)),
    )
    .get(
      "/api/me/reading-lists/:listId/documents",
      mine(TAGS.reading, "A page of a reading list's texts"),
      validator("param", z.object({ listId: schemas.ReadingListIdParam }), badRequest()),
      validator("query", schemas.ReadingListDocumentsQuery, badRequest()),
      responds({ 200: json(schemas.page(schemas.ReadingListDocument), "Texts"), 401: NOT_SIGNED_IN, 404: error("No such list") }),
      (c) =>
        signedIn(c, (user) => {
          const { lang, ...page } = c.req.valid("query");
          return readingLists.documents(deps, user, c.req.valid("param").listId, lang, page);
        }),
    )
    .get(
      "/api/me/reading-list-memberships/:id",
      mine(TAGS.reading, "The lists containing a text"),
      validator("param", z.object({ id: schemas.DocumentId }), badRequest()),
      responds({ 200: json(z.object({ lists: z.array(schemas.ReadingListId) }), "Memberships"), 401: NOT_SIGNED_IN }),
      (c) => signedIn(c, (user) => readingLists.memberships(deps, user, c.req.valid("param").id)),
    )
    .put(
      "/api/me/reading-lists/:listId/documents/:id",
      mine(TAGS.reading, "Add a text to a reading list"),
      validator("param", z.object({ listId: schemas.ReadingListIdParam, id: schemas.DocumentId }), badRequest()),
      responds({ 204: NO_BODY, 401: NOT_SIGNED_IN, 404: error("No such list or document") }),
      (c) => signedIn(c, (user) => readingLists.addDocument(deps, user, c.req.valid("param").listId, c.req.valid("param").id)),
    )
    .delete(
      "/api/me/reading-lists/:listId/documents/:id",
      mine(TAGS.reading, "Remove a text from a reading list"),
      validator("param", z.object({ listId: schemas.ReadingListIdParam, id: schemas.DocumentId }), badRequest()),
      responds({ 204: NO_BODY, 401: NOT_SIGNED_IN, 404: error("No such list") }),
      (c) => signedIn(c, (user) => readingLists.removeDocument(deps, user, c.req.valid("param").listId, c.req.valid("param").id)),
    )
    .get(
      "/api/me/documents",
      mine(TAGS.documents, "A page of the user's own documents", "Public and private."),
      validator("query", schemas.MyDocumentsQuery, badRequest()),
      responds({ 200: json(schemas.page(schemas.DocumentSummary), "A page of documents"), 401: NOT_SIGNED_IN }),
      (c) => signedIn(c, (user) => documents.mine(deps, user, c.req.valid("query"))),
    )
    .get(
      "/api/me/settings",
      mine(TAGS.cards, "The user's review settings"),
      responds({ 200: json(schemas.Settings, "The settings"), 401: NOT_SIGNED_IN }),
      (c) => signedIn(c, (user) => cards.settings(deps, user)),
    )
    .put(
      "/api/me/settings",
      mine(TAGS.cards, "Change the user's review settings"),
      validator("json", schemas.Settings, badRequest()),
      responds({ 204: NO_BODY, 401: NOT_SIGNED_IN }),
      (c) => signedIn(c, (user) => cards.setSettings(deps, user, c.req.valid("json"))),
    )
    .get(
      "/api/documents",
      anyone(
        TAGS.documents,
        "A page of the documents the viewer sees",
        "Public entries, and the viewer's own. tag=kind:value, once or more, keeps entries with any of the values of each kind; " +
          "lang, those in the language; q, those whose title has it; mine=true, only the viewer's own.",
      ),
      validator("query", schemas.DocumentsQuery, badRequest()),
      responds({ 200: json(schemas.page(schemas.DocumentSummary), "A page of documents"), 401: error("mine=true without a session") }),
      async (c) => {
        const { tag, lang, q, mine, ...page } = c.req.valid("query");
        return send(
          c,
          await documents.list(deps, await deps.auth.user(c.req.raw.headers), { tags: tag ?? {}, lang, title: q, mine }, page),
        );
      },
    )
    .get(
      "/api/tags",
      describe({
        tags: [TAGS.documents],
        summary: "A page of the tags that can be given",
        security: [],
        description: "By kind, then in each kind's order.",
      }),
      validator("query", schemas.TagsQuery, badRequest()),
      responds({ 200: json(schemas.page(schemas.AvailableTag), "A page of tags") }),
      async (c) => send(c, await documents.tags(deps, c.req.valid("query"))),
    )
    .get(
      "/api/ingest",
      anyone(
        TAGS.ingest,
        "What analysis is doing",
        "Each language's analyser, if one is running, with the jobs it's running and those waiting, and the jobs started most recently. A text the viewer can't see is shown without its id, title or error.",
      ),
      responds({ 200: json(schemas.IngestOverview, "The analysers and their jobs") }),
      async (c) => send(c, await ingest.overview(deps, await deps.auth.user(c.req.raw.headers))),
    )
    .post(
      "/api/documents",
      mine(
        TAGS.documents,
        "Import a text",
        "A text someone else imported gets the user's own entry, with their title, visibility and licence. A failed import is retried by importing the same text again. Each import counts against the user's limit of imports in a window of time, which skolia.io's own accounts aren't held to.",
      ),
      limit,
      validator("json", schemas.ImportRequest, badRequest()),
      responds({
        200: json(schemas.DocumentSummary, "The text was here already"),
        202: json(schemas.DocumentSummary, "The text is queued for analysis"),
        400: error("A tag skolia doesn't have"),
        401: error("Not signed in"),
        413: error("The text is too long"),
        429: { ...error("The user has imported as many texts as the window allows"), headers: RETRY_AFTER },
      }),
      (c) => signedIn(c, (user) => documents.importText(deps, user, c.req.valid("json")), "sign in to import"),
    )
    .get(
      "/api/documents/:id",
      anyone(
        TAGS.documents,
        "A document",
        "The viewer's own entry for it, else a public one, as it stands. POST …/refresh queues it again if it needs it.",
      ),
      responds({ 200: json(schemas.DocumentSummary, "The entry, with where it is in the queue"), 404: error("No such document") }),
      async (c) => send(c, await documents.get(deps, c.req.param("id"), await deps.auth.user(c.req.raw.headers))),
    )
    .post(
      "/api/documents/:id/refresh",
      anyone(
        TAGS.documents,
        "Queue a document again if it needs it",
        "If ingest now makes another analysis than the document's, or its run seems lost, it's queued again, keeping its last reading meanwhile. Otherwise nothing changes. A reader asks when it opens a text.",
      ),
      responds({ 200: json(schemas.DocumentSummary, "The entry, with where it is in the queue"), 404: error("No such document") }),
      async (c) => send(c, await documents.refresh(deps, c.req.param("id"), await deps.auth.user(c.req.raw.headers))),
    )
    .patch(
      "/api/documents/:id",
      mine(
        TAGS.documents,
        "Change the user's entry for a text",
        "A field left out stays as it is; null clears author or source; tags replace all of its tags.",
      ),
      validator("json", schemas.DocumentUpdate, badRequest()),
      responds({
        200: json(schemas.DocumentSummary, "The changed entry"),
        400: error("A change that isn't allowed"),
        401: NOT_SIGNED_IN,
        403: error("Not the user's entry"),
        404: error("No such document"),
      }),
      (c) => signedIn(c, (user) => documents.update(deps, user, c.req.param("id"), c.req.valid("json"))),
    )
    .delete(
      "/api/documents/:id",
      mine(
        TAGS.documents,
        "Delete the user's entry for a text",
        "The text and its analyses stay, so importing it again needn't analyse it again.",
      ),
      responds({ 204: NO_BODY, 401: NOT_SIGNED_IN, 403: error("Not the user's entry"), 404: error("No such document") }),
      (c) => signedIn(c, (user) => documents.remove(deps, user, c.req.param("id"))),
    )
    .get(
      "/api/documents/:id/text",
      anyone(TAGS.documents, "A document's text", "Its id is the text's hash, so what's here never changes; the ETag says so."),
      describe({
        responses: {
          200: { description: "The text", content: { "text/plain": { schema: { type: "string" } } } },
          304: { description: "The client's copy is current" },
          404: { description: "No such document", content: JSON_ERROR },
        },
      }),
      async (c) =>
        send(c, await documents.text(deps, c.req.param("id"), await deps.auth.user(c.req.raw.headers), c.req.header("if-none-match"))),
    )
    .get(
      "/api/documents/:id/analysis/:name",
      anyone(
        TAGS.documents,
        "A document's analysis",
        "By its name in DocumentSummary.reading: its sentences and tokens (Blob in lib/ts/schema.gen.ts), Brotli-compressed.",
      ),
      describe({ responses: PART_RESPONSES }),
      async (c) =>
        send(
          c,
          await documents.part(
            deps,
            c.req.param("id"),
            await deps.auth.user(c.req.raw.headers),
            c.req.param("name"),
            c.req.header("if-none-match"),
          ),
        ),
    )
    .get(
      "/api/documents/:id/annotations",
      anyone(
        TAGS.annotations,
        "A page of an entry's annotations",
        "Those of the entry the viewer sees, by where they start; from and to keep those overlapping [from, to).",
      ),
      validator("query", schemas.AnnotationsQuery, badRequest()),
      responds({ 200: json(schemas.page(schemas.Annotation), "A page of annotations"), 404: error("No such document") }),
      async (c) => {
        const { from, to, ...page } = c.req.valid("query");
        return send(c, await annotations.list(deps, c.req.param("id"), await deps.auth.user(c.req.raw.headers), { from, to }, page));
      },
    )
    .post(
      "/api/documents/:id/annotations",
      mine(
        TAGS.annotations,
        "Annotate the user's entry",
        `Attach a kind and its data to ranges of the text, up to ${ANNOTATION_BATCH} at once, in one transaction. Those the entry has already are left as they are.`,
      ),
      annotationLimit,
      validator("json", schemas.NewAnnotations, badRequest()),
      responds({
        200: json(schemas.Annotated, "The annotations, as the entry has them, and how many are new"),
        400: error("One ends after the text does"),
        401: NOT_SIGNED_IN,
        404: error("The user hasn't imported the text"),
        409: error("The entry filled up before it had them all; those before stay"),
        413: error("The annotations are too big"),
      }),
      (c) => signedIn(c, (user) => annotations.add(deps, user, c.req.param("id"), c.req.valid("json"))),
    )
    .delete(
      "/api/documents/:id/annotations/:annotationId",
      mine(TAGS.annotations, "Delete an annotation from the user's entry"),
      validator("param", z.object({ id: z.string(), annotationId: schemas.AnnotationId }), badRequest(ANNOTATION_ID_MESSAGE)),
      responds({ 204: NO_BODY, 401: NOT_SIGNED_IN, 404: error("No such annotation") }),
      (c) => signedIn(c, (user) => annotations.remove(deps, user, c.req.param("id"), c.req.valid("param").annotationId)),
    );
  return app;
}

/** The response for a result, typed by its status so the typed client (hono/client)
 * knows each status's body. */
type Sent<R> = R extends BlobResult | NotModified
  ? Response
  : R extends { status: 204 }
    ? Response & TypedResponse<null, 204, "body">
    : R extends { status: infer S extends ContentfulStatusCode; body: infer B }
      ? Response & TypedResponse<JSONParsed<B>, S, "json">
      : never;

function send<R extends Result>(c: Context, result: R): Sent<R> {
  if ("etag" in result) return sendBlob(c, result) as Sent<R>;
  if (!("body" in result)) return c.body(null, 204) as Sent<R>;
  return c.json(result.body as object, result.status, result.headers) as unknown as Sent<R>;
}

/** Workers can't decompress Brotli, so a client that doesn't accept a blob's encoding
 * gets 406 (browsers all accept br). no-cache: the browser keeps its copy, and asks
 * before each use whether it may still see it (BlobResult). */
function sendBlob(c: Context, result: BlobResult | NotModified): Response {
  const { etag, encoding } = result;
  const cached = { etag, "cache-control": "private, no-cache", ...(encoding === undefined ? {} : { vary: "accept-encoding" }) };
  if (result.status === 304) return new Response(null, { status: 304, headers: cached });
  const { blob } = result;
  const headers: Record<string, string> = { ...cached, "content-type": blob.contentType ?? "application/octet-stream" };
  if (encoding === undefined) return new Response(blob.body, { headers });
  if (acceptsEncoding(c.req.header("accept-encoding"), encoding)) {
    headers["content-encoding"] = encoding;
    // Workers otherwise compress the body again by its content-encoding; Node ignores it
    const init: ResponseInit & { encodeBody: "manual" } = { headers, encodeBody: "manual" };
    return new Response(blob.body, init);
  }
  return c.json({ error: `needs Accept-Encoding: ${encoding}` } satisfies ApiError, 406);
}

/** Whether an Accept-Encoding header ("gzip, deflate, br;q=0.8") allows the encoding. */
export function acceptsEncoding(header: string | undefined, encoding: string): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (name !== encoding && name !== "*") return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}
