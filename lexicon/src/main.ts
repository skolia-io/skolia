// skolia-lexicon on Cloudflare Workers (lexicon/wrangler.jsonc): the lexicon's public API
// (app.ts) at lexicon.skolia.io, and LexiconService, which the API binds for its cards.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { LemmaId, Lookup } from "@skolia/shared/api";
import { createApp } from "./app.ts";
import { D1Lexicon, lexiconsOf, type LexiconBindings } from "./store.ts";

export class LexiconService extends WorkerEntrypoint<LexiconBindings> {
  async entries(ids: readonly LemmaId[]): Promise<Lookup> {
    return await new D1Lexicon(lexiconsOf(this.env)).entries(ids);
  }
}

export default {
  fetch(request, env, ctx) {
    return createApp({ lexicon: new D1Lexicon(lexiconsOf(env)), cache: caches.default }).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<LexiconBindings>;
