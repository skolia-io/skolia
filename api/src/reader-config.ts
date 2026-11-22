// What the reader is set to do in a deployment, from the Worker's vars (api/wrangler.jsonc),
// sent at /api/config. A deploy changes them.
import * as z from "zod";
import { LEXICON_CONCURRENCY, type ReaderConfig } from "@skolia/shared/api";
import * as schemas from "@skolia/shared/schemas";
import { fromVar } from "./vars.ts";

const Concurrency = z.coerce.number().pipe(schemas.ReaderConfig.shape.lexiconConcurrency);

/** The vars it's read from: strings, or what JSON gave in the wrangler config. */
export type ReaderVars = { readonly READER_LEXICON_CONCURRENCY?: unknown };

/** The reader's config from the vars: an unset or invalid var is the default (fromVar). */
export function readerConfig({ READER_LEXICON_CONCURRENCY: value }: ReaderVars): ReaderConfig {
  return { lexiconConcurrency: fromVar("READER_LEXICON_CONCURRENCY", value, Concurrency, LEXICON_CONCURRENCY.default) };
}
