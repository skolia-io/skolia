// The spec lexicon-api/openapi.json holds, made from the marks on the routes' middleware
// (@skolia/util/openapi). just openapi writes it, and spec.test.ts checks it's current.
import type { OpenAPIV3_1 } from "openapi-types";
import { specJson } from "@skolia/util/openapi-spec";
import { createApp, type Deps } from "./app.ts";
import { LICENSE } from "./licence.ts";

const DOCUMENTATION = {
  openapi: "3.1.0",
  info: {
    title: "skolia lexicon",
    version: "v1",
    license: { name: "CC BY-SA 4.0", identifier: LICENSE.type },
    description:
      "Dictionary entries for the languages skolia reads (English, French, Polish): senses, relations between words, " +
      "pronunciations and inflected forms, mostly from Wiktionary. No sign-in. The content is CC BY-SA 4.0: each entry says " +
      "whom to credit (attribution) and links its Wiktionary page (sourceUrl). A lexicon's version changes when a new " +
      "build is loaded. Pass that version as a lookup query parameter to enable edge caching. An entry's id is " +
      "{lang}:{lemma}:{upos}, a lemma with a / percent-encoded in a path (pl:i%2Flub:CCONJ).",
  },
  servers: [{ url: "..", description: "Where this spec is served from" }],
  security: [],
  tags: [{ name: "Lexicon", description: "Entries, and each language's lexicon" }],
} as const satisfies Partial<OpenAPIV3_1.Document>;

/** The spec, as JSON has it. Making it runs no route, so the app needs no deps. */
export async function lexiconSpec(): Promise<unknown> {
  return await specJson(createApp({} as Deps), DOCUMENTATION);
}

if (import.meta.main) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(new URL("../openapi.json", import.meta.url), `${JSON.stringify(await lexiconSpec(), null, 2)}\n`);
}
