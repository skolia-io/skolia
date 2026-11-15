import assert from "node:assert/strict";
import { test } from "node:test";
import type { Piece } from "@skolia/shared/doc";
import type { Token } from "@skolia/shared/schema";
import * as schemas from "@skolia/shared/schemas";
import { audioAnnotations, inRange, placeAudio } from "./annotations.ts";

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
  const places = placeAudio(
    text,
    laid,
    audioAnnotations([
      annotation(0, second - 2, 1),
      annotation(second, text.length, 2),
      annotation(4, 6, 3),
      annotation(second - 2, third - 2, 4),
      annotation(second, text.indexOf(".", second), 5),
    ]),
  );
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
  assert.equal(placeAudio(text, pieces(text), audioAnnotations([annotation(3, 5)])).size, 0);
});

test("a range past a character outside the BMP finds its word", () => {
  const text = "😀 Ala.\n\nKot ma.";
  const kot = text.indexOf("Kot");
  const places = placeAudio(text, pieces(text), audioAnnotations([annotation(kot, text.length)]));
  // 😀, Ala., Kot, ma. with a gap before each but the first
  assert.deepEqual([...places.keys()], [4]);
});
