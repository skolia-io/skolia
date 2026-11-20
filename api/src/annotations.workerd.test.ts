import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANNOTATION_BATCH,
  ANNOTATION_PAGE,
  MAX_ANNOTATIONS,
  type Annotation,
  type AnnotationKey,
  type DocumentId,
  type ImportRequest,
  type NewAnnotation,
} from "@skolia/shared/api";
import type { Cursor } from "@skolia/shared/page";
import { sql } from "@skolia/util/sql";
import { ALICE, NOW, TEXT, client, importer, local, raw, refusesBadPages, setup, useLocal, walk, type App } from "./testing/app.ts";
import { body, expectStatus } from "@skolia/util/responses";
import { prepare } from "@skolia/util/d1";

useLocal();

const PUBLIC = { visibility: "public", licence: "cc0" } as const;

type Attribution = Partial<Pick<NewAnnotation, "licence" | "author" | "source">>;

/** A recording of the text's characters start to end. */
function audio(start: number, end: number, attribution: Attribution = {}, url = `https://example.org/${start}.mp3`): NewAnnotation {
  return { start, end, kind: "audio", data: { url }, licence: "cc-by-4.0", author: "Helena", ...attribution };
}

/** A note on the text's characters start to end. */
function note(start: number, end: number, text: string, attribution: Attribution = {}): NewAnnotation {
  return { start, end, kind: "text", data: { text }, licence: "cc0", ...attribution };
}

async function imported(app: App, headers: Headers, fields: Partial<ImportRequest> = {}, text = TEXT): Promise<DocumentId> {
  return (await body("import", client(app, headers).documents.$post({ json: { text, lang: "pl", ...fields } }), 202)).id;
}

function annotate(app: App, headers: Headers | undefined, id: string, annotations: NewAnnotation[]) {
  return client(app, headers).documents[":id"].annotations.$post({ param: { id }, json: { annotations } });
}

/** Adds one annotation, giving it as the entry has it. */
async function annotateOne(
  what: string,
  app: App,
  headers: Headers | undefined,
  id: string,
  annotation: NewAnnotation,
): Promise<Annotation> {
  const [added] = (await body(what, annotate(app, headers, id, [annotation]))).annotations;
  if (!added) throw new Error(`${what}: no annotation`);
  return added;
}

/** n recordings of the text's first word, each its own. */
function recordings(n: number, from = 0): NewAnnotation[] {
  return Array.from({ length: n }, (_, i) => audio(0, 3, {}, `https://example.org/${from + i}.mp3`));
}

function annotations(
  app: App,
  headers: Headers | undefined,
  id: string,
  query: { readonly after?: Cursor<AnnotationKey> | undefined; readonly limit?: string; readonly from?: string; readonly to?: string } = {},
) {
  return client(app, headers).documents[":id"].annotations.$get({ param: { id }, query });
}

function unannotate(app: App, headers: Headers | undefined, id: string, annotationId: string) {
  return client(app, headers).documents[":id"].annotations[":annotationId"].$delete({ param: { id, annotationId } });
}

async function starts(app: App, headers: Headers | undefined, id: string): Promise<readonly number[]> {
  return (await body("annotations", annotations(app, headers, id))).items.map((a) => a.start);
}

test("an entry's user adds annotations, which whoever sees the entry sees in order", async () => {
  const app = setup();
  const id = await imported(app, importer, PUBLIC);
  const second = await annotateOne("add", app, importer, id, audio(5, 10, { source: "https://example.org/story" }));
  assert.deepEqual(
    { ...second, id: undefined },
    {
      id: undefined,
      start: 5,
      end: 10,
      kind: "audio",
      data: { url: "https://example.org/5.mp3" },
      licence: "cc-by-4.0",
      author: "Helena",
      source: "https://example.org/story",
      addedAt: "2026-11-04T00:00:00.000Z",
    },
  );
  const { author: _, ...anonymous } = audio(0, 4);
  await annotateOne("add", app, importer, id, anonymous);
  const alice = await local.signIn((await local.signUp(ALICE)).id);
  for (const headers of [importer, alice, undefined]) assert.deepEqual(await starts(app, headers, id), [0, 5]);
  const { items } = await body("annotations", annotations(app, undefined, id));
  assert.deepEqual([items[0]?.author, items[0]?.source], [null, null]);
  assert.deepEqual(items[1], second);
  const translated = await annotateOne("note", app, importer, id, note(0, 10, " I'm going to the old dog. "));
  assert.deepEqual([translated.kind, translated.data], ["text", { text: "I'm going to the old dog." }]);
  const listed = (await body("annotations", annotations(app, alice, id))).items.find((a) => a.id === translated.id);
  assert.deepEqual(listed, translated);
  if (listed?.kind === "text") assert.equal(listed.data.text.length, 25);
});

test("adding the same annotation again keeps the one there; a changed one is another", async () => {
  const app = setup();
  const id = await imported(app, importer);
  const first = await annotateOne("add", app, importer, id, audio(0, 4));
  const again = await annotateOne("again", setup({ at: "2026-11-05T00:00:00Z" }), importer, id, audio(0, 4));
  assert.deepEqual(again, first);
  const changed = await annotateOne("changed", app, importer, id, audio(0, 4, { licence: "cc0" }));
  assert.notEqual(changed.id, first.id);
  assert.deepEqual(await starts(app, importer, id), [0, 0]);
});

test("a private entry's annotations are seen by its user alone, as its text is", async () => {
  const app = setup();
  const id = await imported(app, importer);
  await annotateOne("add", app, importer, id, audio(0, 4));
  assert.deepEqual(await starts(app, importer, id), [0]);
  const alice = await local.signIn((await local.signUp(ALICE)).id);
  await expectStatus("someone else", annotations(app, alice, id), 404);
  await expectStatus("signed out", annotations(app, undefined, id), 404);
  await expectStatus("unknown text", annotations(app, importer, "0".repeat(64)), 404);
  await expectStatus("not an id", annotations(app, importer, "nope"), 404);
});

test("each user sees their own entry's annotations, and others the earliest public entry's", async () => {
  const app = setup();
  const id = await imported(app, importer, PUBLIC);
  await annotateOne("add", app, importer, id, audio(0, 4));
  const alice = await local.signIn((await local.signUp(ALICE)).id);
  await body(
    "alice imports, later",
    client(setup({ at: "2026-11-05T00:00:00Z" }), alice).documents.$post({ json: { text: TEXT, lang: "pl", ...PUBLIC } }),
  );
  assert.deepEqual(await starts(app, alice, id), []);
  await annotateOne("alice adds", app, alice, id, audio(5, 10));
  assert.deepEqual(await starts(app, alice, id), [5]);
  assert.deepEqual(await starts(app, importer, id), [0]);
  assert.deepEqual(await starts(app, undefined, id), [0]);
});

test("only the entry's user adds and removes its annotations", async () => {
  const app = setup();
  const id = await imported(app, importer, PUBLIC);
  const { id: annotationId } = await annotateOne("add", app, importer, id, audio(0, 4));
  const alice = await local.signIn((await local.signUp(ALICE)).id);
  await expectStatus("someone else adds", annotate(app, alice, id, [audio(5, 10)]), 404);
  await expectStatus("signed out adds", annotate(app, undefined, id, [audio(5, 10)]), 401);
  await expectStatus("unknown text", annotate(app, importer, "0".repeat(64), [audio(0, 4)]), 404);
  await expectStatus("someone else removes", unannotate(app, alice, id, annotationId), 404);
  await expectStatus("signed out removes", unannotate(app, undefined, id, annotationId), 401);
  await body("alice imports", client(app, alice).documents.$post({ json: { text: TEXT, lang: "pl" } }));
  await expectStatus("not on her entry", unannotate(app, alice, id, annotationId), 404);
  assert.deepEqual(await starts(app, undefined, id), [0]);
  await expectStatus("removes", unannotate(app, importer, id, annotationId), 204);
  await expectStatus("removes again", unannotate(app, importer, id, annotationId), 404);
  await expectStatus("not an annotation id", unannotate(app, importer, id, "nope"), 400);
  assert.deepEqual(await starts(app, undefined, id), []);
});

test("an annotation's data must be its kind's, its range in the text and its licence shareable", async () => {
  const text = "Pies 🐕 szczeka.";
  const app = setup();
  const id = await imported(app, importer, {}, text);
  const refused = async (what: string, json: NewAnnotation, error: string) => {
    const response = await expectStatus(what, annotate(app, importer, id, [json]), 400);
    assert.deepEqual(await response.json(), { error }, what);
  };
  // What the typed client won't send
  const malformed = async (what: string, json: unknown, error: string) => {
    const response = await raw(app, "POST", `/api/documents/${id}/annotations`, importer, { annotations: [json] });
    assert.deepEqual([response.status, await response.json()], [400, { error }], what);
  };
  const range = { start: 0, end: 4, licence: "cc0" };
  await malformed("unknown kind", { ...range, kind: "video", data: { url: "https://example.org/a.mp4" } }, "kind must be audio or text");
  await malformed("no kind", { ...range, data: { url: "https://example.org/a.mp3" } }, "kind must be audio or text");
  await malformed("another kind's data", { ...range, kind: "audio", data: { text: "Pies" } }, "audio annotation data needs a url");
  await malformed("no url", { ...range, kind: "audio", data: {} }, "audio annotation data needs a url");
  await malformed(
    "more than a url",
    { ...range, kind: "audio", data: { url: "https://example.org/a.mp3", speed: 2 } },
    "audio annotation data has only url",
  );
  await malformed("no data", { ...range, kind: "text" }, "text annotation data must be {text}");
  await refused("http", audio(0, 4, {}, "http://example.org/a.mp3"), "url must be an https URL");
  await refused("blank text", note(0, 4, "  "), "text must be non-empty");
  await refused("long text", note(0, 4, "x".repeat(2001)), "text is at most 2000 characters");
  await refused("empty", audio(4, 4), "an annotation must end after it starts");
  await refused("backwards", audio(4, 2), "an annotation must end after it starts");
  await refused(
    "past the end",
    audio(0, text.length + 1),
    `annotation 0 ends at ${text.length + 1}, after the text's end at ${text.length}`,
  );
  await refused("bad source", audio(0, 4, { source: "ftp://example.org" }), "source must be an http(s) URL");
  await refused("blank author", audio(0, 4, { author: " " }), "author must be non-empty");
  for (const licence of ["all-rights-reserved", "unknown", "mit"]) {
    const response = await raw(app, "POST", `/api/documents/${id}/annotations`, importer, { annotations: [{ ...audio(0, 4), licence }] });
    assert.deepEqual(
      [response.status, await response.json()],
      [400, { error: "an annotation needs a licence that allows sharing it" }],
      licence,
    );
  }
  // UTF-16, as JavaScript counts: the dog is two units
  assert.equal(text.length, 16);
  await annotateOne("to the end", app, importer, id, audio(5, text.length));
  await annotateOne("longest text", app, importer, id, note(5, 6, "x".repeat(2000)));
  const tooBig = await raw(app, "POST", `/api/documents/${id}/annotations`, importer, {
    annotations: [audio(0, 4, { author: "x".repeat(2 * 1024 * ANNOTATION_BATCH) })],
  });
  assert.deepEqual(
    [tooBig.status, await tooBig.json()],
    [413, { error: `a batch of annotations is at most ${2 * 1024 * ANNOTATION_BATCH} bytes` }],
  );
  assert.deepEqual(await starts(app, importer, id), [5, 5]);
});

test("an entry's annotations come a page at a time, by where they start", async () => {
  const app = setup();
  const id = await imported(app, importer, PUBLIC);
  for (const start of [8, 0, 3, 3, 12])
    await annotateOne("add", app, importer, id, audio(start, start + 2, { author: `${start}-${Math.random()}` }));
  const { items, next } = await body("annotations", annotations(app, undefined, id));
  assert.equal(next, null);
  assert.deepEqual(
    items.map((a) => a.start),
    [0, 3, 3, 8, 12],
  );
  assert.deepEqual(
    await walk(2, (after?: Cursor<AnnotationKey>) => body("annotations", annotations(app, undefined, id, { after, limit: "2" }))),
    items,
  );
  await refusesBadPages(ANNOTATION_PAGE.max, (query) => annotations(app, undefined, id, query));
});

test("from and to keep the annotations that overlap [from, to), a page at a time", async () => {
  const app = setup();
  const id = await imported(app, importer, PUBLIC);
  for (const [start, end] of [
    [0, 4],
    [5, 10],
    [12, 14],
    [0, 18],
  ] as const)
    await annotateOne("add", app, importer, id, audio(start, end));
  // Annotations starting at the same place are in id order, a hash's, so these compare as sets
  const ranges = (items: readonly { start: number; end: number }[]) =>
    items.map((a) => [a.start, a.end]).sort(([a, b], [c, d]) => a! - c! || b! - d!);
  const within = async (from?: string, to?: string) =>
    ranges(
      (
        await body(
          `${from}-${to}`,
          annotations(app, undefined, id, { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }),
        )
      ).items,
    );
  assert.deepEqual(await within("3", "6"), [
    [0, 4],
    [0, 18],
    [5, 10],
  ]);
  assert.deepEqual(await within("4", "5"), [[0, 18]]);
  assert.deepEqual(await within("10"), [
    [0, 18],
    [12, 14],
  ]);
  assert.deepEqual(await within(undefined, "1"), [
    [0, 4],
    [0, 18],
  ]);
  assert.deepEqual(await within("14", "18"), [[0, 18]]);
  assert.equal((await within()).length, 4);
  const paged = await walk(1, (after?: Cursor<AnnotationKey>) =>
    body("annotations", annotations(app, undefined, id, { after, limit: "1", from: "3", to: "6" })),
  );
  assert.deepEqual(ranges(paged), [
    [0, 4],
    [0, 18],
    [5, 10],
  ]);
  for (const [from, to] of [
    ["6", "6"],
    ["6", "5"],
    ["-1", "5"],
    ["x", "5"],
    ["0", "20001"],
  ] as const) {
    await expectStatus(`${from}-${to}`, annotations(app, undefined, id, { from, to }), 400);
  }
});

test("an entry has at most MAX_ANNOTATIONS, and its annotations go with it", async () => {
  const app = setup();
  const id = await imported(app, importer);
  const { id: kept } = await annotateOne("add", app, importer, id, audio(0, 1));
  const user = (await body("me", client(app, importer).me.$get())).id;
  const db = local.env.DB;
  await db.batch(
    Array.from({ length: MAX_ANNOTATIONS - 1 }, (_, i) =>
      prepare(
        db,
        sql`INSERT INTO user_document_annotation (user_id, document_id, id, start, "end", kind, data, attribution_id, added_at)
          VALUES ${sql.tuple([user, id, i.toString(16).padStart(64, "0"), 1, 2, "audio", '{"url":"https://example.org/x.mp3"}', sql`(SELECT attribution_id FROM user_document_annotation WHERE id = ${kept})`, new Date(NOW).toISOString()])}`,
      ),
    ),
  );
  const full = await expectStatus("full", annotate(app, importer, id, [audio(2, 3)]), 409);
  assert.deepEqual(await full.json(), { error: `an entry has at most ${MAX_ANNOTATIONS} annotations` });
  await expectStatus("one it has", annotate(app, importer, id, [audio(0, 1)]), 200);
  await expectStatus("removes one", unannotate(app, importer, id, kept), 204);
  await annotateOne("room again", app, importer, id, audio(2, 3));
  await expectStatus("deletes the entry", client(app, importer).documents[":id"].$delete({ param: { id } }), 204);
  await body("imports again", client(app, importer).documents.$post({ json: { text: TEXT, lang: "pl" } }));
  assert.deepEqual(await starts(app, importer, id), []);
});

test("a batch adds the annotations the entry hasn't, and gives them all back in order", async () => {
  const app = setup();
  const id = await imported(app, importer, PUBLIC);
  const { id: had } = await annotateOne("add one", app, importer, id, audio(5, 7));
  const batch = [audio(5, 7), note(0, 3, "I go"), ...recordings(ANNOTATION_BATCH - 3), note(0, 3, "I go")];
  const added = await body("batch", annotate(app, importer, id, batch));
  assert.equal(added.added, ANNOTATION_BATCH - 2);
  assert.deepEqual(
    added.annotations.map((a) => [a.start, a.end, a.kind]),
    batch.map((a) => [a.start, a.end, a.kind]),
  );
  assert.equal(added.annotations[0]?.id, had);
  assert.equal(added.annotations[1]?.id, added.annotations.at(-1)?.id);
  assert.equal((await body("again", annotate(app, importer, id, batch))).added, 0);
  assert.equal((await body("annotations", annotations(app, undefined, id))).items.length, ANNOTATION_BATCH - 1);
});

test("a batch is refused whole when it's not the user's entry or one annotation isn't valid", async () => {
  const app = setup();
  const id = await imported(app, importer, PUBLIC);
  const alice = await local.signIn((await local.signUp(ALICE)).id);
  await expectStatus("someone else", annotate(app, alice, id, recordings(2)), 404);
  await expectStatus("signed out", annotate(app, undefined, id, recordings(2)), 401);
  await expectStatus("unknown text", annotate(app, importer, "0".repeat(64), recordings(2)), 404);
  const after = await expectStatus(
    "one ends after the text",
    annotate(app, importer, id, [...recordings(2), audio(0, TEXT.length + 1)]),
    400,
  );
  assert.deepEqual(await after.json(), { error: `annotation 2 ends at ${TEXT.length + 1}, after the text's end at ${TEXT.length}` });
  await expectStatus(
    "one isn't its kind's",
    annotate(app, importer, id, [...recordings(2), { ...note(0, 3, "x"), data: {} } as NewAnnotation]),
    400,
  );
  await expectStatus("none", annotate(app, importer, id, []), 400);
  await expectStatus("too many", annotate(app, importer, id, recordings(ANNOTATION_BATCH + 1)), 400);
  assert.deepEqual(await starts(app, undefined, id), []);
});

test("a batch that fills the entry up adds those before, and is refused", async () => {
  const app = setup();
  const id = await imported(app, importer);
  const { id: kept } = await annotateOne("add", app, importer, id, audio(0, 1));
  const user = (await body("me", client(app, importer).me.$get())).id;
  const db = local.env.DB;
  await db.batch(
    Array.from({ length: MAX_ANNOTATIONS - 3 }, (_, i) =>
      prepare(
        db,
        sql`INSERT INTO user_document_annotation (user_id, document_id, id, start, "end", kind, data, attribution_id, added_at)
          VALUES ${sql.tuple([user, id, i.toString(16).padStart(64, "0"), 1, 2, "audio", '{"url":"https://example.org/x.mp3"}', sql`(SELECT attribution_id FROM user_document_annotation WHERE id = ${kept})`, new Date(NOW).toISOString()])}`,
      ),
    ),
  );
  const full = await expectStatus("full", annotate(app, importer, id, recordings(4)), 409);
  assert.deepEqual(await full.json(), { error: `an entry has at most ${MAX_ANNOTATIONS} annotations` });
  const first = await body("the first two stayed", annotate(app, importer, id, recordings(2)));
  assert.equal(first.added, 0);
});
