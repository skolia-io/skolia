import assert from "node:assert/strict";
import { test } from "node:test";
import type { Piece } from "@skolia/shared/doc";
import type { Token } from "@skolia/shared/schema";
import * as schemas from "@skolia/shared/schemas";
import { audioAnnotations, byLength, clipsOf, inRange, piecesIn, placeAudio } from "./annotations.ts";

const fields = {
  licence: "public-domain",
  author: null,
  source: null,
  addedAt: "2026-11-09T10:00:00.000Z",
};

function annotation(start: number, end: number, n = 1) {
  return schemas.Annotation.parse({
    ...fields,
    id: String(n).repeat(64),
    start,
    end,
    kind: "audio",
    data: { url: `https://audio.test/${n}.mp3` },
  });
}

test("only audio annotations are kept", () => {
  const audio = annotation(0, 5);
  const note = schemas.Annotation.parse({ ...annotation(5, 9, 2), kind: "text", data: { text: "a note" } });
  assert.deepEqual(audioAnnotations([audio, note]), [audio]);
});

/** The text's words and the gaps between them, as layout makes them. */
function pieces(text: string): Piece[] {
  const words = [...text.matchAll(/\S+/gu)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  return words.flatMap(({ start, end }, i): Piece[] => {
    const before = words[i - 1]?.end ?? 0;
    const token = { start, end, upos: "NOUN" } as Token;
    const word: Piece = { kind: "word", id: i, text: text.slice(start, end), words: [{ sentence: 0, index: i, token }], punct: false };
    return start > before ? [{ kind: "gap", text: text.slice(before, start) }, word] : [word];
  });
}

test("a clip of whole paragraphs has its button before their first word; a shorter one has none", () => {
  const text = "Ala ma kota.\n\nKot ma Alę.\n\nAla ma psa.";
  const second = text.indexOf("Kot");
  const third = text.lastIndexOf("Ala");
  const laid = pieces(text);
  const { paragraphs, shorter } = byLength(
    text,
    audioAnnotations([
      annotation(0, second - 2, 1),
      annotation(second, text.length, 2),
      annotation(4, 6, 3),
      annotation(second - 2, third - 2, 4),
      annotation(second, text.indexOf(".", second), 5),
    ]),
  );
  assert.deepEqual(
    shorter.map((p) => p.id[0]),
    ["3", "4", "5"],
  );
  const places = placeAudio(laid, paragraphs);
  const at = (piece: number) => places.get(piece)?.map((p) => p.id[0]);
  // Ala: the first paragraph; Kot: the second and third; not ma, the gap before Kot, or Kot ma Alę without its stop
  assert.deepEqual([...places.keys()], [0, 6]);
  assert.deepEqual([at(0), at(6)], [["1"], ["2"]]);
  assert.deepEqual(
    laid.filter((piece) => inRange(places.get(6)?.[0] ?? assert.fail(), piece)).map((p) => p.kind === "word" && p.text),
    ["Kot", "ma", "Alę.", "Ala", "ma", "psa."],
  );
});

test("a clip with no word in its range has no button", () => {
  const text = "Ala  ma";
  assert.equal(placeAudio(pieces(text), audioAnnotations([annotation(3, 5)])).size, 0);
});

test("a range past a character outside the BMP finds its word", () => {
  const text = "😀 Ala.\n\nKot ma.";
  const kot = text.indexOf("Kot");
  const places = placeAudio(pieces(text), audioAnnotations([annotation(kot, text.length)]));
  // 😀, Ala., Kot, ma. with a gap before each but the first
  assert.deepEqual([...places.keys()], [4]);
});

test("a recording's pieces are its words and what's between them, not the gaps at its ends", () => {
  const text = "Ala ma kota,\na kot Alę.";
  const laid = pieces(text);
  const shown = (annotations: ReturnType<typeof annotation>[]) =>
    [...piecesIn(laid, audioAnnotations(annotations))].map((i) => laid[i]?.text ?? assert.fail());
  // ma, and kota, to a over the line break
  const ma = text.indexOf("ma");
  const kota = text.indexOf("kota");
  assert.deepEqual(shown([annotation(ma, ma + 2)]), ["ma"]);
  assert.deepEqual(shown([annotation(kota, text.indexOf("\na kot") + 2, 2)]), ["kota,", "\n", "a"]);
  // Two that share a word, and one with no word
  assert.deepEqual(shown([annotation(0, ma + 2), annotation(ma, ma + 2, 2), annotation(3, 4, 3)]), ["Ala", " ", "ma"]);
});

test("a word's clips are the recordings with it in their range, with their words on one line", () => {
  const text = "Ala ma kota,\na kot Alę.";
  const laid = pieces(text);
  const kota = text.indexOf("kota");
  const [word, phrase, elsewhere] = audioAnnotations([
    annotation(kota, kota + 4, 1),
    annotation(kota, text.indexOf("\na kot") + 2, 2),
    annotation(0, 3, 3),
  ]);
  const piece = laid.find((p) => p.text === "kota,") ?? assert.fail();
  assert.deepEqual(
    clipsOf(
      text,
      [word, phrase, elsewhere].map((a) => a ?? assert.fail()),
      piece,
    ),
    [
      { annotation: word, words: "kota" },
      { annotation: phrase, words: "kota, a" },
    ],
  );
});
