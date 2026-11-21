// The lexicon API's requests and responses. Entries are what the API's cards show and a
// Worker serves (@skolia/shared/schema Entry), with what a reuser needs to credit them.
import * as z from "zod";
import { UPOS } from "@skolia/shared/api";
import * as schemas from "@skolia/shared/schemas";
import { MAX_INCOMING } from "./ports.ts";

export const License = z
  .object({
    type: z.string().describe("SPDX identifier: CC-BY-SA-4.0"),
    url: z.url().describe("The licence's deed"),
    text: z.string(),
  })
  .meta({ id: "License", description: "The licence the lexicon's content is under" });

export const Attribution = z
  .object({
    title: z.string(),
    author: z.string(),
    url: z.url(),
    license: z.string().describe("SPDX identifier"),
    via: z.url().optional().describe("Where skolia took it from, when that isn't the source"),
    provides: z.string().describe("What of the entry it gives"),
  })
  .meta({ id: "Attribution", description: "A source to credit: its title, author, URL and licence" });

const Incoming = z
  .array(schemas.Relation)
  .describe(
    `With include=incoming, the relations pointing at this entry, ${MAX_INCOMING} at most, by source id: ` +
      "each one's lemma and lemma_id are its source's, and the rest is as the source has it",
  );

export const Entry = z
  .intersection(
    schemas.Entry,
    z.object({
      sourceUrl: z.url().describe("The entry's page on English Wiktionary"),
      license: License,
      attribution: z.array(Attribution),
      incoming: Incoming.optional(),
      incomingTruncated: z.boolean().optional().describe(`With include=incoming, whether more than ${MAX_INCOMING} point at it`),
    }),
  )
  .meta({
    id: "CreditedEntry",
    description:
      'A lexicon entry with its credits. Its paradigms\' forms point into feature sets, ["psa", [50, 51]], which the response carries.',
  });

export const Entries = z
  .object({
    entries: z.array(Entry).describe("The entries asked for that the lexicon has, by id"),
    related: z.array(Entry).describe("With include=related, the entries their relations point at"),
    featureSets: z.partialRecord(schemas.Lang, schemas.FeatureSets),
  })
  .meta({ id: "Entries" });

export const ResolvedEntry = Entries.extend({ requestedId: schemas.LemmaId }).meta({ id: "ResolvedEntry" });

export const About = z
  .object({
    lang: schemas.Lang,
    version: z.string().nullable().describe("The version served, which changes when a new build is loaded; null before one is"),
    license: License,
    sources: z.array(Attribution),
  })
  .meta({ id: "About", description: "A language's lexicon" });

const INCLUDES = ["related", "incoming"] as const;

export const Include = z
  .string()
  .regex(new RegExp(`^(${INCLUDES.join("|")})(,(${INCLUDES.join("|")}))*$`))
  .optional()
  .transform((list) => {
    const named = new Set(list?.split(",") ?? []);
    return { related: named.has("related"), incoming: named.has("incoming") };
  })
  .describe("What to bring besides the entries, comma-separated: related, incoming");

const Version = z.string().min(1).optional().describe("Pin the lookup to the version from GET /v1/lexicons/{lang} to enable edge caching");

export const IncludeQuery = z.object({ include: Include, version: Version });

export const LangParam = z.object({ lang: schemas.Lang });

export const LemmaParam = z.object({ lang: schemas.Lang, lemma: z.string().min(1).max(100) });

export const FormParam = z.object({ lang: schemas.Lang, form: z.string().min(1).max(100) });
export const FormQuery = z.object({ upos: z.enum(UPOS), version: Version });
export const FormAudio = z
  .object({ pronunciations: z.array(schemas.Pronunciation), recordings: z.array(schemas.Recording) })
  .meta({ id: "FormAudio" });

export const IdParam = z.object({ id: schemas.LemmaId });

export type EntryBody = z.output<typeof Entry>;

export type EntriesBody = z.output<typeof Entries>;
