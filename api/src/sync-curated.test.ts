import assert from "node:assert/strict";
import { test } from "node:test";
import { ANNOTATION_BATCH, timestamp, type Annotation, type DocumentId, type DocumentSummary, type UserId } from "@skolia/shared/api";
import type { Graph } from "@skolia/util/graph";
import { plan, toCurated, type Change, type Curated, type CuratedAnnotation } from "./sync-curated.ts";

const TEXT = { title: "A", licence: "cc0", tags: {}, text: "Ala ma kota." } as const;
const KOT = { kind: "text", data: { text: "cat" }, licence: "cc0", start: 7, end: 11 } as const;
const ALA = { kind: "text", data: { text: "Alice" }, licence: "cc0", start: 0, end: 3 } as const;

function summary({ id, request }: Curated): DocumentSummary {
  return {
    id,
    title: request.title ?? "",
    lang: request.lang,
    importedAt: timestamp(new Date(0)),
    words: 3,
    visibility: "public",
    licence: request.licence,
    author: null,
    source: null,
    tags: {},
    importer: { id: "curated" as UserId, name: "Curated" },
    mine: true,
    state: "ready",
  };
}

function stored({ id, request }: CuratedAnnotation): Annotation {
  return { ...request, id, author: null, source: null, addedAt: timestamp(new Date(0)) };
}

/** A change as a word and what it's about */
function label(change: Change): string {
  switch (change.kind) {
    case "import":
    case "update":
      return `${change.kind} ${change.text.path}`;
    case "delete":
      return `delete ${change.document.id}`;
    case "unannotate":
      return `unannotate ${change.annotation.id}`;
    case "annotate":
      return `annotate ${change.annotations.map((a) => a.id).join(" ")}`;
  }
}

/** Each change, and the changes it depends on */
const edges = (graph: Graph<Change>) =>
  graph.ids().map((id) => [label(graph.value(id)), graph.before(id).map((before) => label(graph.value(before)))]);

test("a text imported now gets all its annotations once it's imported, and other texts don't wait", async () => {
  const text = await toCurated("pl/a.yaml", "pl", { ...TEXT, annotations: [KOT, ALA] });
  const other = await toCurated("pl/b.yaml", "pl", { ...TEXT, text: "Inny tekst.", annotations: [] });
  const [kot, ala] = text.annotations.map((a) => a.id);
  assert.deepEqual(edges(plan([text, other], [], new Map())), [
    ["import pl/a.yaml", []],
    [`annotate ${kot} ${ala}`, ["import pl/a.yaml"]],
    ["import pl/b.yaml", []],
  ]);
});

test("an imported text's annotations not in its file are removed, and those missing added after", async () => {
  const before = await toCurated("pl/a.yaml", "pl", { ...TEXT, annotations: [KOT, ALA] });
  const after = await toCurated("pl/a.yaml", "pl", { ...TEXT, annotations: [{ ...KOT, data: { text: "a cat" } }, ALA] });
  const [kot, ala] = before.annotations;
  const [edited] = after.annotations;
  assert.ok(kot && ala && edited);
  const had = new Map<DocumentId, readonly Annotation[]>([[before.id, [kot, ala].map(stored)]]);
  assert.equal(plan([before], [summary(before)], had).size, 0);
  assert.deepEqual(edges(plan([after], [summary(after)], had)), [
    [`unannotate ${kot.id}`, []],
    [`annotate ${edited.id}`, [`unannotate ${kot.id}`]],
  ]);
  assert.deepEqual(edges(plan([{ ...after, annotations: [] }], [summary(after)], had)), [
    [`unannotate ${kot.id}`, []],
    [`unannotate ${ala.id}`, []],
  ]);
});

test("a text's new annotations go in batches of ANNOTATION_BATCH, and a document not in curated/ is deleted", async () => {
  const notes = Array.from({ length: ANNOTATION_BATCH + 1 }, (_, i) => ({ ...KOT, data: { text: `cat ${i}` } }));
  const text = await toCurated("pl/a.yaml", "pl", { ...TEXT, annotations: notes });
  const gone = await toCurated("pl/gone.yaml", "pl", { ...TEXT, text: "Nie ma.", annotations: [] });
  const graph = plan([{ ...text, request: { ...text.request, title: "B" } }], [summary(text), summary(gone)], new Map());
  assert.deepEqual(
    graph.ids().map((id) => {
      const change = graph.value(id);
      return change.kind === "annotate" ? change.annotations.length : change.kind;
    }),
    ["update", ANNOTATION_BATCH, 1, "delete"],
  );
  assert.ok(graph.ids().every((id) => graph.before(id).length === 0));
});
