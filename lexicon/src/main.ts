// skolia-lexicon on Cloudflare Workers (lexicon/wrangler.jsonc): the lexicon's public API
// (app.ts) at lexicon.skolia.io, and LexiconService, which the API binds for its cards and
// to pass /api/lexicon/* on to the same API.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { LemmaId, Lookup } from "@skolia/shared/api";
import { createApp } from "./app.ts";
import { D1Lexicon, lexiconsOf, type LexiconBindings } from "./store.ts";

function serve(request: Request, env: LexiconBindings, ctx: ExecutionContext): Response | Promise<Response> {
  return createApp({ lexicon: new D1Lexicon(lexiconsOf(env), "first-primary") }).fetch(request, env, ctx);
}

export class LexiconService extends WorkerEntrypoint<LexiconBindings> {
  override fetch(request: Request): Response | Promise<Response> {
    return serve(request, this.env, this.ctx);
  }

  async entries(ids: readonly LemmaId[]): Promise<Lookup> {
    return await new D1Lexicon(lexiconsOf(this.env)).entries(ids);
  }
}

export default { fetch: serve } satisfies ExportedHandler<LexiconBindings>;
