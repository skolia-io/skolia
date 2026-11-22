// Print the frame patterns the word sheet would show, for some lemmas from a lexicon response.
// usage: node lib/ts/scripts/show-frames.ts ENTRIES.json pl:szukać:VERB pl:mieć:VERB ...
import { readFileSync } from "node:fs";
import type { Entry } from "@skolia/shared/schema";
import { frames } from "../lang/pl/frames.ts";

const [path, ...ids] = process.argv.slice(2);
if (!path) throw new Error("usage: show-frames.ts ENTRIES.json LEMMA_ID...");
const { entries } = JSON.parse(readFileSync(path, "utf-8")) as { entries: Entry[] };
for (const id of ids) {
  const entry = entries.find((entry) => entry.lemma_id === id);
  if (!entry) {
    console.log(`${id}: entry missing`);
    continue;
  }
  const shown = frames(entry.frames);
  console.log(`\n${entry.lemma} (${entry.frames.length} schemata, ${shown.length} patterns)`);
  for (const frame of shown) {
    const tags = frame.tags.length ? `  (${frame.tags.join(", ")})` : "";
    const head = `${entry.lemma}${frame.reflexive ? " się" : ""}`;
    console.log(`  ${frame.idiom ? "idiom " : "      "}${head} ${frame.pattern}${tags}`);
  }
}
