// A text's annotations as the reader shows them: audio only, for now, and only recordings of
// whole paragraphs, each a play button before the paragraph's first word.
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

/** Each audio annotation that covers whole paragraphs, by the index of the piece its button
 * goes before: the first word that ends after the range starts, if it starts before the range
 * ends. A shorter one, a word or a phrase, has no button yet. */
export function placeAudio(
  text: string,
  pieces: readonly Piece[],
  annotations: readonly AudioAnnotation[],
): ReadonlyMap<number, readonly AudioAnnotation[]> {
  const words = pieces.flatMap((piece, index) => {
    const token = piece.kind === "word" ? piece.words[0]?.token : undefined;
    return token ? [{ index, start: token.start, end: token.end }] : [];
  });
  const bounds = paragraphs(text);
  const starts = new Set(bounds.map(([start]) => start));
  const ends = new Set(bounds.map(([, end]) => end));
  return annotations.reduce((places, annotation) => {
    if (!starts.has(annotation.start) || !ends.has(annotation.end)) return places;
    const word = words[firstEndingAfter(words, annotation.start)];
    if (word && word.start < annotation.end) places.set(word.index, [...(places.get(word.index) ?? []), annotation]);
    return places;
  }, new Map<number, readonly AudioAnnotation[]>());
}

/** The first word, in order, that ends after offset; words.length if none does. */
function firstEndingAfter(words: readonly { readonly end: number }[], offset: number): number {
  let [low, high] = [0, words.length];
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((words[middle]?.end ?? Infinity) > offset) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** Whether the piece is a word in the range. */
export function inRange(range: AudioAnnotation, piece: Piece): boolean {
  const token = piece.kind === "word" ? piece.words[0]?.token : undefined;
  return token !== undefined && token.start < range.end && token.end > range.start;
}
