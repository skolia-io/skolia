import { queryOptions, type QueryClient } from "@tanstack/svelte-query";
import { langOf, type Lang, type LemmaId } from "@skolia/shared/api";
import type { Token } from "@skolia/shared/schema";
import { LemmaId as LemmaIdSchema } from "@skolia/shared/schemas";
import { getEntry, getFormAudio, getLexiconInfo, LexiconVersionChanged } from "./api.ts";

const VERSION_CHECK_INTERVAL = 60 * 60 * 1000;
const CONCURRENCY = 6;

export function tokenLemma(token: Token): LemmaId | undefined {
  return LemmaIdSchema.safeParse(token.lemma_id).data;
}

type Job = { readonly id: LemmaId; readonly version: string | null; readonly run: () => Promise<void> };

class EntryQueue {
  private pending: Job[] = [];
  private active = 0;

  get(id: LemmaId, version: string | null) {
    return new Promise<Awaited<ReturnType<typeof getEntry>>>((resolve, reject) => {
      this.pending.push({ id, version, run: () => getEntry(id, version).then(resolve, reject) });
      this.drain();
    });
  }

  promote(id: LemmaId, version: string | null): void {
    const index = this.pending.findIndex((job) => job.id === id && job.version === version);
    const job = this.pending[index];
    if (index > 0 && job) {
      this.pending.splice(index, 1);
      this.pending.unshift(job);
    }
  }

  private drain(): void {
    while (this.active < CONCURRENCY) {
      const job = this.pending.shift();
      if (job === undefined) return;
      this.active++;
      void job.run().finally(() => {
        this.active--;
        this.drain();
      });
    }
  }
}

const queues = new WeakMap<QueryClient, EntryQueue>();

function queueOf(client: QueryClient): EntryQueue {
  const existing = queues.get(client);
  if (existing !== undefined) return existing;
  const queue = new EntryQueue();
  queues.set(client, queue);
  return queue;
}

function versionError(client: QueryClient, lang: Lang, error: unknown): never {
  if (error instanceof LexiconVersionChanged) void client.invalidateQueries({ queryKey: lexiconInfoQuery(lang).queryKey });
  throw error;
}

export function entryQuery(client: QueryClient, id: LemmaId, version: string | null | undefined) {
  return queryOptions({
    queryKey: ["lexicon", "entry", id, version ?? null] as const,
    queryFn: () =>
      queueOf(client)
        .get(id, version ?? null)
        .catch((error: unknown) => versionError(client, langOf(id), error)),
    enabled: version !== undefined,
    staleTime: version == null ? VERSION_CHECK_INTERVAL : Infinity,
    gcTime: Infinity,
  });
}

export function prefetchEntry(client: QueryClient, id: LemmaId, version: string | null, priority = false): void {
  void client.prefetchQuery(entryQuery(client, id, version));
  if (priority) queueOf(client).promote(id, version);
}

export function formAudioQuery(client: QueryClient, lang: Lang, token: Token, version: string | null | undefined, enabled: boolean) {
  return queryOptions({
    queryKey: ["lexicon", "form", lang, version ?? null, token.text, token.upos] as const,
    queryFn: () => getFormAudio(lang, token.text, token.upos, version ?? null).catch((error: unknown) => versionError(client, lang, error)),
    enabled: enabled && version !== undefined,
    staleTime: version == null ? VERSION_CHECK_INTERVAL : Infinity,
    gcTime: Infinity,
  });
}

export function lexiconInfoQuery(lang: Lang | undefined) {
  return queryOptions({
    queryKey: ["lexicon", "info", lang] as const,
    queryFn: () => (lang === undefined ? null : getLexiconInfo(lang)),
    enabled: lang !== undefined,
    gcTime: VERSION_CHECK_INTERVAL,
    staleTime: VERSION_CHECK_INTERVAL,
    refetchInterval: VERSION_CHECK_INTERVAL,
  });
}
