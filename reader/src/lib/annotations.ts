// A text's annotations as the reader shows them: audio only, for now. A recording of whole
// paragraphs is a play button before the paragraph's first word; a shorter one, a word or a
// phrase, underlines its words, and the word sheet of each plays it.
import type { Annotation } from "@skolia/shared/api";
import type { Piece } from "@skolia/shared/doc";

export type AudioAnnotation = Extract<Annotation, { readonly kind: "audio" }>;

/** The audio annotations among the API's. */
export function audioAnnotations(annotations: readonly Annotation[]): readonly AudioAnnotation[] {
  return annotations.filter((a): a is AudioAnnotation => a.kind === "audio");
}

/** The text's paragraphs, split on blank lines and trimmed, as [start, end) in UTF-16 units. */
function paragraphs(text: string): readonly (readonly [number, number])[] {
  const breaks = [...text.matchAll(/\n[^\S\n]*\n\s*/gu)];
  const spans = [0, ...breaks.map((b) => b.index + b[0].length)].map((from, i) => [from, breaks[i]?.index ?? text.length] as const);
  return spans.flatMap(([from, to]) => {
    const part = text.slice(from, to);
    const start = from + (part.length - part.trimStart().length);
    const end = to - (part.length - part.trimEnd().length);
    return start < end ? [[start, end] as const] : [];
  });
}

/** The audio annotations that start and end at paragraphs' bounds, and the shorter ones. */
export function byLength(
  text: string,
  annotations: readonly AudioAnnotation[],
): { readonly paragraphs: readonly AudioAnnotation[]; readonly shorter: readonly AudioAnnotation[] } {
  const bounds = paragraphs(text);
  const starts = new Set(bounds.map(([start]) => start));
  const ends = new Set(bounds.map(([, end]) => end));
  const whole = (annotation: AudioAnnotation) => starts.has(annotation.start) && ends.has(annotation.end);
  return { paragraphs: annotations.filter(whole), shorter: annotations.filter((a) => !whole(a)) };
}

type PlacedWord = { readonly index: number; readonly start: number; readonly end: number };

/** The pieces that are words, with their index and range. */
function placedWords(pieces: readonly Piece[]): readonly PlacedWord[] {
  return pieces.flatMap((piece, index) => {
    const token = piece.kind === "word" ? piece.words[0]?.token : undefined;
    return token ? [{ index, start: token.start, end: token.end }] : [];
  });
}

/** The words in the range, as [first, end) indices into words. */
function wordsIn(words: readonly PlacedWord[], range: AudioAnnotation): readonly [number, number] {
  return [firstWhere(words, (w) => w.end > range.start), firstWhere(words, (w) => w.start >= range.end)];
}

/** Each recording of whole paragraphs (byLength), by the index of the piece its button goes
 * before: the first word in its range. */
export function placeAudio(
  pieces: readonly Piece[],
  annotations: readonly AudioAnnotation[],
): ReadonlyMap<number, readonly AudioAnnotation[]> {
  const words = placedWords(pieces);
  return annotations.reduce((places, annotation) => {
    const [first, end] = wordsIn(words, annotation);
    const word = words[first];
    if (word && first < end) places.set(word.index, [...(places.get(word.index) ?? []), annotation]);
    return places;
  }, new Map<number, readonly AudioAnnotation[]>());
}

/** The pieces in the ranges: their words, and the gaps and punctuation between two words of one range. */
export function piecesIn(pieces: readonly Piece[], annotations: readonly AudioAnnotation[]): ReadonlySet<number> {
  const words = placedWords(pieces);
  return new Set(
    annotations.flatMap((annotation) => {
      const [first, end] = wordsIn(words, annotation);
      const from = words[first]?.index;
      const to = words[end - 1]?.index;
      return from === undefined || to === undefined || first >= end ? [] : Array.from({ length: to - from + 1 }, (_, i) => from + i);
    }),
  );
}

/** The first of the words, in order, that passes test, which every one after it passes too;
 * words.length if none does. */
function firstWhere(words: readonly PlacedWord[], test: (word: PlacedWord) => boolean): number {
  let [low, high] = [0, words.length];
  while (low < high) {
    const middle = (low + high) >> 1;
    const word = words[middle];
    if (word === undefined || test(word)) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** Whether the piece is a word in the range. */
export function inRange(range: AudioAnnotation, piece: Piece): boolean {
  const token = piece.kind === "word" ? piece.words[0]?.token : undefined;
  return token !== undefined && token.start < range.end && token.end > range.start;
}

/** A recording shorter than a paragraph, with the words it says. */
export type Clip = { readonly annotation: AudioAnnotation; readonly words: string };

/** The recordings that have the piece in their range, with their words on one line. */
export function clipsOf(text: string, annotations: readonly AudioAnnotation[], piece: Piece): readonly Clip[] {
  return annotations
    .filter((annotation) => inRange(annotation, piece))
    .map((annotation) => ({ annotation, words: text.slice(annotation.start, annotation.end).replace(/\s+/gu, " ").trim() }));
}
