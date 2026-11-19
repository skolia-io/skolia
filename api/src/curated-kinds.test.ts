import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { annotationId } from "@skolia/shared/annotations";
import { docId } from "@skolia/shared/keys";
import { parseCurated, readCurated, resolveCurated } from "./sync-curated.ts";

test("an inline file is its credits and text", async () => {
  const yaml =
    "kind: inline\ntitle: Inwokacja\nauthor: Adam Mickiewicz\nlicence: public-domain\nsource: https://wolnelektury.pl/katalog/lektura/pan-tadeusz/\ntags:\n  level: C2\ntext: |\n  Litwo! Ojczyzno moja!\n";
  const [text] = await resolveCurated([parseCurated("pl/a.yaml", "pl", yaml)]);
  assert.equal(text?.id, await docId("pl", "Litwo! Ojczyzno moja!"));
  assert.deepEqual(text?.request, {
    title: "Inwokacja",
    text: "Litwo! Ojczyzno moja!",
    lang: "pl",
    visibility: "public",
    licence: "public-domain",
    author: "Adam Mickiewicz",
    source: "https://wolnelektury.pl/katalog/lektura/pan-tadeusz/",
    tags: { level: "C2" },
  });
});

test("a file that isn't YAML of a kind is refused, naming the file and what's wrong", () => {
  const refused = (yaml: string, message: RegExp) => assert.throws(() => parseCurated("pl/a.yaml", "pl", yaml), message);
  refused("kind: inline\ntitle: [", /^Error: pl\/a\.yaml: /u);
  refused("kind: gutenberg\nid: 1342\n", /pl\/a\.yaml: kind: /u);
  refused("kind: inline\ntitle: A\ntext: B\n", /pl\/a\.yaml: licence: /u);
  refused("kind: inline\ntitle: A\nlicence: cc0\ntext: B\nyear: 1834\n", /pl\/a\.yaml: .*year/u);
  refused("kind: inline\ntitle: A\nlicence: cc0\ntext: B\ntags:\n  level: B 1\n", /pl\/a\.yaml: tags\.level: /u);
  refused("kind: inline\ntitle: A\nlicence: cc0\ntext: B\ntags:\n  Level: B1\n", /pl\/a\.yaml: tags\.Level: /u);
});

const WLOSY = `kind: inline
title: Włosy
licence: cc-by-nc-4.0
text: |

  [Thuli ma krótkie włosy.]{2}

  [Anna ma długie włosy.]{3} Bez adnotacji, i [jedno słowo]{kot}.
annotations:
  "2":
    kind: audio
    url: https://example.org/02.mp3
    licence: cc-by-4.0
    author: Helena Gabriela
    source: https://example.org/story
  3:
    kind: text
    text: " Anna has long hair. "
    licence: cc0
  kot:
    - kind: text
      text: cat
      licence: cc0
    - kind: audio
      url: https://example.org/kot.mp3
      licence: cc0
`;

test("an inline text's annotations are on its spans, in the text without markup, trimmed", async () => {
  const [text] = await resolveCurated([parseCurated("pl/w.yaml", "pl", WLOSY)]);
  const plain = "Thuli ma krótkie włosy.\n\nAnna ma długie włosy. Bez adnotacji, i jedno słowo.";
  assert.equal(text?.request.text, plain);
  assert.equal(text?.id, await docId("pl", plain));
  assert.deepEqual(
    text?.annotations.map((a) => [plain.slice(a.request.start, a.request.end), a.request.kind]),
    [
      ["Thuli ma krótkie włosy.", "audio"],
      ["Anna ma długie włosy.", "text"],
      ["jedno słowo", "text"],
      ["jedno słowo", "audio"],
    ],
  );
  const kot = { start: 64, end: 75, licence: "cc0", author: null, source: null } as const;
  assert.deepEqual(
    text?.annotations.map((a) => a.id),
    [
      await annotationId({
        kind: "audio",
        data: { url: "https://example.org/02.mp3" },
        licence: "cc-by-4.0",
        author: "Helena Gabriela",
        source: "https://example.org/story",
        start: 0,
        end: 23,
      }),
      await annotationId({ kind: "text", data: { text: "Anna has long hair." }, ...kot, start: 25, end: 46 }),
      await annotationId({ kind: "text", data: { text: "cat" }, ...kot }),
      await annotationId({ kind: "audio", data: { url: "https://example.org/kot.mp3" }, ...kot }),
    ],
  );
});

test("bad annotations or markup are refused offline, naming the file and what's wrong", () => {
  const inline = (text: string, annotations: string) =>
    `kind: inline\ntitle: A\nlicence: cc0\ntext: |\n  ${text}\nannotations:\n${annotations}`;
  const annotation = (label: string, fields: string) => `  ${label}:\n${fields.replace(/^/gmu, "    ")}\n`;
  const audio = (label: string) => annotation(label, "kind: audio\nurl: https://example.org/a.mp3\nlicence: cc0");
  const refused = (yaml: string, message: RegExp) => assert.throws(() => parseCurated("pl/a.yaml", "pl", yaml), message);
  refused(inline("[a]{x", audio("x")), /^Error: pl\/a\.yaml: text: line 1: \] needs a \{label\}/u);
  refused(inline("[a]{x} [b]{y}", audio("x")), /pl\/a\.yaml: text: \{y\} has no annotations/u);
  refused(inline("[a]{x}", audio("x") + audio("y")), /pl\/a\.yaml: annotations\.y: no span in the text has this label/u);
  refused(inline("[a]{x}", audio("x") + audio("Y")), /pl\/a\.yaml: annotations\.Y: a label is lowercase/u);
  refused(inline("[a]{x}", "  x: []\n"), /pl\/a\.yaml: annotations\.x: /u);
  refused(
    inline("[a]{x}", annotation("x", "kind: video\nlicence: cc0")),
    /pl\/a\.yaml: annotations\.x\.0\.kind: kind must be audio or text/u,
  );
  refused(
    inline("[a]{x}", annotation("x", "kind: audio\nurl: http://example.org/a.mp3\nlicence: cc0")),
    /pl\/a\.yaml: annotations\.x\.0\.url: url must be an https URL/u,
  );
  refused(
    inline("[a]{x}", annotation("x", "kind: text\ntext: a\nlicence: all-rights-reserved")),
    /pl\/a\.yaml: annotations\.x\.0\.licence: an annotation needs a licence that allows sharing it/u,
  );
  refused(
    inline("[a]{x}", annotation("x", 'kind: text\ntext: a\nlicence: cc0\nauthor: ""')),
    /pl\/a\.yaml: annotations\.x\.0\.author: author must be non-empty/u,
  );
  refused(
    inline("[a]{x}", annotation("x", "kind: text\ntext: a\nlicence: cc0\nstart: 0")),
    /pl\/a\.yaml: annotations\.x\.0: text annotation has only text/u,
  );
});

test("an annotation given twice on a span is refused", async () => {
  const yaml =
    "kind: inline\ntitle: A\nlicence: cc0\ntext: '[a]{x}'\nannotations:\n  x:\n    - kind: text\n      text: a\n      licence: cc0\n    - kind: text\n      text: a\n      licence: cc0\n";
  await assert.rejects(resolveCurated([parseCurated("pl/a.yaml", "pl", yaml)]), /pl\/a\.yaml: the same annotation twice at 0-1/u);
});

test("a span only on what's trimmed is refused", async () => {
  const yaml = "kind: inline\ntitle: A\nlicence: cc0\ntext: '[ ]{x}a'\nannotations:\n  x:\n    kind: text\n    text: a\n    licence: cc0\n";
  await assert.rejects(
    resolveCurated([parseCurated("pl/a.yaml", "pl", yaml)]),
    /pl\/a\.yaml: the annotation at 0-0: an annotation must end after it starts/u,
  );
});

test("a public inline text needs a licence that allows sharing it", async () => {
  const file = parseCurated("pl/a.yaml", "pl", "kind: inline\ntitle: A\nlicence: all-rights-reserved\ntext: B\n");
  await assert.rejects(resolveCurated([file]), /pl\/a\.yaml: a public text needs/u);
});

test("two files with the same text are refused", async () => {
  const same = (path: string) => parseCurated(path, "pl", "kind: inline\ntitle: A\nlicence: cc0\ntext: Ten sam tekst.\n");
  await assert.rejects(resolveCurated([same("pl/a.yaml"), same("pl/b.yaml")]), /pl\/b\.yaml: the same text as pl\/a\.yaml/u);
});

test("curated/ is read by language, and holds only .yaml files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "curated-"));
  await mkdir(join(dir, "pl"));
  await writeFile(join(dir, "pl", "a.yaml"), "kind: inline\ntitle: A\nlicence: cc0\ntext: Tekst.\n");
  assert.deepEqual(
    (await readCurated(dir)).map((f) => [f.path, f.lang, f.spec.kind]),
    [[join(dir, "pl", "a.yaml"), "pl", "inline"]],
  );
  await writeFile(join(dir, "pl", "b.txt"), "title: B\nlicence: cc0\n---\nTekst.");
  await assert.rejects(readCurated(dir), /b\.txt: not a \.yaml file/u);
  await mkdir(join(dir, "de"));
  await assert.rejects(readCurated(dir), /de: not a language/u);
});

test("annotations can share fields through YAML merge keys", async () => {
  const yaml =
    "kind: inline\ntitle: A\nlicence: cc0\nsource: &story https://example.org/story\ntext: '[a]{x} [b]{y}'\nannotations:\n" +
    "  x:\n    <<: &narration\n      kind: audio\n      licence: cc-by-4.0\n      source: *story\n    url: https://example.org/x.mp3\n" +
    "  y:\n    <<: *narration\n    url: https://example.org/y.mp3\n";
  const [text] = await resolveCurated([parseCurated("pl/a.yaml", "pl", yaml)]);
  assert.deepEqual(
    text?.annotations.map((a) => [a.request.kind, a.request.data, a.request.licence, a.request.source]),
    [
      ["audio", { url: "https://example.org/x.mp3" }, "cc-by-4.0", "https://example.org/story"],
      ["audio", { url: "https://example.org/y.mp3" }, "cc-by-4.0", "https://example.org/story"],
    ],
  );
});
