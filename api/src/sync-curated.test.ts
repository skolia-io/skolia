import assert from "node:assert/strict";
import { test } from "node:test";
import { ANNOTATION_BATCH, timestamp, type Annotation, type DocumentId, type DocumentSummary, type UserId } from "@skolia/shared/api";
import type { Graph } from "@skolia/util/graph";
import { parseCurated, plan, sampleCurated, toCurated, type Change, type Curated, type CuratedAnnotation } from "./sync-curated.ts";

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
const edges = ({ nodes, deps }: Graph<Change>) =>
  nodes.map((change, id) => [label(change), (deps[id] ?? []).map((dep) => label(nodes[dep] as Change))]);

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
  assert.deepEqual(plan([before], [summary(before)], had).nodes, []);
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
    graph.nodes.map((change) => (change.kind === "annotate" ? change.annotations.length : change.kind)),
    ["update", ANNOTATION_BATCH, 1, "delete"],
  );
  assert.ok(graph.deps.every((deps) => deps.length === 0));
});

test("a sample takes a text from each language, kind and whether it's annotated in turn, the same each time", () => {
  const inline = (path: string, lang: "en" | "pl", annotated = false) =>
    parseCurated(
      path,
      lang,
      annotated
        ? "kind: inline\ntitle: A\nlicence: cc0\ntext: '[Ala]{a} ma kota.'\nannotations:\n  a: { kind: text, text: Alice, licence: cc0 }\n"
        : "kind: inline\ntitle: A\nlicence: cc0\ntext: Ala ma kota.\n",
    );
  const files = [
    inline("pl/w2.yaml", "pl"),
    inline("pl/a2.yaml", "pl", true),
    inline("en/plain.yaml", "en"),
    inline("pl/a1.yaml", "pl", true),
    inline("pl/w1.yaml", "pl"),
    inline("pl/plain.yaml", "pl"),
    inline("pl/a3.yaml", "pl", true),
  ];
  const paths = (n: number, from = files) => sampleCurated(from, n).map((f) => f.path);
  assert.deepEqual(paths(5), ["en/plain.yaml", "pl/plain.yaml", "pl/a1.yaml", "pl/w1.yaml", "pl/a2.yaml"]);
  assert.deepEqual(paths(5, files.toReversed()), paths(5));
  assert.equal(paths(100).length, files.length);
  assert.deepEqual(paths(2), ["en/plain.yaml", "pl/plain.yaml"]);
});
