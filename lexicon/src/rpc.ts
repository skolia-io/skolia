// What the API calls on the lexicon Worker it binds (LEXICON, entrypoint LexiconService),
// apart from main.ts so the API's types don't take in the lexicon Worker's
import type { LemmaId, Lookup } from "@skolia/shared/api";

export type LexiconRpc = Rpc.WorkerEntrypointBranded & {
  /** The entries a card shows, with the entries the relations of those with no senses
   * point at, each language's from the version it serves. Ids it doesn't have are left out. */
  entries(ids: readonly LemmaId[]): Promise<Lookup>;
};
