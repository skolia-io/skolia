// How many times a user may do something costly in a window of time, from the Worker's vars
// (api/wrangler.jsonc). The user's Durable Object counts them; users with a role that
// grants unlimited-rate aren't counted.
import * as z from "zod";
import { fromVar } from "./vars.ts";

/** At most limit in each window of windowSeconds, the window starting at the first. */
export type RateLimit = { readonly limit: number; readonly windowSeconds: number };

/** Imports, which start ingest's runs, when the vars are unset or invalid. */
export const IMPORT_RATE: RateLimit = { limit: 20, windowSeconds: 60 * 60 };

const Limit = z.coerce.number().pipe(z.int().min(1).max(10_000));
/** Up to a week. */
const WindowSeconds = z.coerce.number().pipe(
  z
    .int()
    .min(1)
    .max(7 * 24 * 60 * 60),
);

/** The vars they're read from: strings, or what JSON gave in the wrangler config. */
export type RateVars = { readonly IMPORT_RATE_LIMIT?: unknown; readonly IMPORT_RATE_WINDOW_SECONDS?: unknown };

/** The import limit from the vars, each unset or invalid one its default (fromVar). */
export function importRate({ IMPORT_RATE_LIMIT, IMPORT_RATE_WINDOW_SECONDS }: RateVars): RateLimit {
  return {
    limit: fromVar("IMPORT_RATE_LIMIT", IMPORT_RATE_LIMIT, Limit, IMPORT_RATE.limit),
    windowSeconds: fromVar("IMPORT_RATE_WINDOW_SECONDS", IMPORT_RATE_WINDOW_SECONDS, WindowSeconds, IMPORT_RATE.windowSeconds),
  };
}
