import type { LemmaId, Lookup } from "@skolia/shared/api";
import * as schemas from "@skolia/shared/schemas";
import type { LexiconRpc } from "@skolia/lexicon/rpc";
import type { Lexicon } from "../../ports/lexicon.ts";

/** The lexicon Worker's LexiconService (lexicon-api/src/main.ts), bound as LEXICON. RPC's
 * types widen the paradigms' [form, sets] tuples to arrays, so what comes back is parsed
 * into a Lookup again. */
export class RpcLexicon implements Lexicon {
  private readonly service: Service<LexiconRpc>;

  constructor(service: Service<LexiconRpc>) {
    this.service = service;
  }

  async entries(ids: readonly LemmaId[]): Promise<Lookup> {
    return schemas.Lookup.parse(await this.service.entries(ids));
  }
}
