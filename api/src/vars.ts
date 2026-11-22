// Settings from the Worker's vars (api/wrangler.jsonc), which a deploy changes.
import * as z from "zod";
import { log } from "@skolia/util/log";

const logger = log("api");

/** The last invalid value warned about, by var. */
const warned = new Map<string, unknown>();

/** The var's value, parsed with the schema. Unset or empty is the default; so is an invalid
 * value, with a warning, once per value, so that a bad var doesn't take the API down. */
export function fromVar<T>(name: string, value: unknown, schema: z.ZodType<T>, fallback: T): T {
  if (value === undefined || value === "") return fallback;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (warned.get(name) !== value) {
    warned.set(name, value);
    logger.warn("a var is invalid; using its default", { name, value, default: fallback, error: z.prettifyError(parsed.error) });
  }
  return fallback;
}
