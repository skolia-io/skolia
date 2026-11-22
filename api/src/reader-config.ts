// What the reader is set to do in a deployment, from the Worker's vars (api/wrangler.jsonc),
// sent with /api/version. A deploy changes them.
import * as z from "zod";
import { LEXICON_CONCURRENCY, type ReaderConfig } from "@skolia/shared/api";
import * as schemas from "@skolia/shared/schemas";
import { log } from "@skolia/util/log";

const logger = log("api");

const Concurrency = z.coerce.number().pipe(schemas.ReaderConfig.shape.lexiconConcurrency);

/** The vars it's read from: strings, or what JSON gave in the wrangler config. */
export type ReaderVars = { readonly READER_LEXICON_CONCURRENCY?: unknown };

let warned: unknown;

/** The reader's config from the vars. An unset var is the default; so is an invalid one,
 * with a warning, once per value, so that a bad var doesn't take the reader down. */
export function readerConfig({ READER_LEXICON_CONCURRENCY: value }: ReaderVars): ReaderConfig {
  if (value === undefined || value === "") return { lexiconConcurrency: LEXICON_CONCURRENCY.default };
  const parsed = Concurrency.safeParse(value);
  if (parsed.success) return { lexiconConcurrency: parsed.data };
  if (warned !== value) {
    warned = value;
    logger.warn("READER_LEXICON_CONCURRENCY is invalid; the reader gets the default", {
      value,
      default: LEXICON_CONCURRENCY.default,
      error: z.prettifyError(parsed.error),
    });
  }
  return { lexiconConcurrency: LEXICON_CONCURRENCY.default };
}
