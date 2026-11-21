<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { LANGS, LANGUAGE_INFO, blankParts, type Card, type Lang, type LemmaId, type User } from "@skolia/shared/api";
  import { signIn } from "../lib/api.ts";
  import { createCardList, createDeleteCard, type CardPage } from "../lib/cards.ts";
  import { countsQuery } from "../lib/queries.ts";
  import { CARD_KIND_LABELS, scheduleLabel } from "../lib/schedule.ts";
  import Button from "../components/Button.svelte";
  import Page from "../components/Page.svelte";

  /** lang: from the route, or the language with the most to review. */
  let { user, lang }: { user: User | null | undefined; lang: Lang | null } = $props();

  const cardCounts = createQuery(() => ({ ...countsQuery, enabled: !!user && lang === null }));
  const busiest = $derived(
    cardCounts.data?.reduce<{ lang: Lang; n: number } | null>((best, c) => {
      const n = c.words.due + c.words.new + c.forms.due + c.forms.new;
      return n > (best?.n ?? 0) ? { lang: c.lang, n } : best;
    }, null)?.lang ?? null,
  );
  const selected = $derived(lang ?? (cardCounts.data ? (busiest ?? LANGS[0]) : null));
  const list = createCardList(() => selected);
  const remove = createDeleteCard();
  const pages = $derived(list.data?.pages ?? []);
  const cards = $derived(pages.flatMap((page) => page.items.map((card) => ({ card, page }))));
  const now = new Date();
  const groups = $derived(groupByLemma(cards));
  let error = $state<string | null>(null);
  const failure = $derived(error ?? (cardCounts.error ?? list.error)?.message ?? null);

  /** One or more of a lemma's cards, shown and deleted together. */
  type Row = readonly [Card, ...Card[]];

  /** A lemma's cards, in the order its first card came. Its recognition and production cards
   * share a row when they're at the same point in their schedules; each cloze card has its own. */
  type Group = { readonly lemmaId: LemmaId; readonly page: CardPage; readonly rows: readonly Row[] };

  function groupByLemma(cards: readonly { card: Card; page: CardPage }[]): readonly Group[] {
    const byLemma = new Map<LemmaId, { page: CardPage; cards: Card[] }>();
    for (const { card, page } of cards) {
      const group = byLemma.get(card.lemmaId);
      if (group) group.cards.push(card);
      else byLemma.set(card.lemmaId, { page, cards: [card] });
    }
    return [...byLemma].map(([lemmaId, { page, cards }]) => {
      const ofKind = (kind: Card["kind"]) => cards.filter((card) => card.kind === kind);
      const [recognition] = ofKind("recognition");
      const [production] = ofKind("production");
      const words: readonly Row[] =
        recognition && production && scheduleLabel(recognition, now) === scheduleLabel(production, now)
          ? [[recognition, production]]
          : [recognition, production].flatMap((card) => (card ? [[card] as const] : []));
      return { lemmaId, page, rows: [...words, ...ofKind("cloze").map((card) => [card] as const)] };
    });
  }

  function lemmaOf(lemmaId: LemmaId, page: CardPage): string {
    return page.entries.get(lemmaId)?.lemma ?? lemmaId.split(":")[1] ?? lemmaId;
  }

  function glossOf(lemmaId: LemmaId, page: CardPage): string | null {
    return page.entries.get(lemmaId)?.senses[0]?.gloss ?? null;
  }

  function kindsLabel(row: Row): string {
    return row.length === 2 ? "Recognition & production" : CARD_KIND_LABELS[row[0].kind];
  }

  async function deleteRow(row: Row): Promise<void> {
    if (!confirm(row.length === 1 ? "Delete this card and its reviews?" : `Delete these ${row.length} cards and their reviews?`)) return;
    error = null;
    try {
      await Promise.all(row.map((card) => remove.mutateAsync(card.id)));
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<Page title="Manage cards">
  {#snippet actions()}
    {#if user && selected}
      <select aria-label="Language" value={selected} onchange={(event) => (location.hash = `#/cards/${event.currentTarget.value}`)}>
        {#each LANGS as code (code)}
          <option value={code} lang={code}>{LANGUAGE_INFO[code].flag} {LANGUAGE_INFO[code].endonym}</option>
        {/each}
      </select>
    {/if}
  {/snippet}

  {#if user === null}
    <p class="muted">Sign in to see your cards.</p>
    <Button variant="primary" onclick={() => void signIn()}>Sign in</Button>
  {:else if user && selected}
    {#if !list.data}
      {#if !failure}
        <p class="muted">Loading…</p>
      {/if}
    {:else if cards.length === 0}
      <p class="muted"> No cards in {LANGUAGE_INFO[selected].name} yet. Words you look up in the reader turn into cards here. </p>
    {:else}
      <ul class="cards" class:stale={list.isPlaceholderData}>
        {#each groups as { lemmaId, page, rows } (lemmaId)}
          <li>
            <p><strong class="lemma" lang={selected}>{lemmaOf(lemmaId, page)}</strong></p>
            {#if glossOf(lemmaId, page)}
              <p class="muted">{glossOf(lemmaId, page)}</p>
            {/if}
            <ul class="rows">
              {#each rows as row (row[0].id)}
                {@const card = row[0]}
                <li>
                  {#if card.kind === "cloze"}
                    {@const parts = blankParts(card.data)}
                    <p class="front"
                      ><span class="sentence" lang={selected}>{parts.before}<mark>{parts.blank}</mark>{parts.after}</span>
                      <a class="muted" href="#/doc/{card.data.documentId}">Source</a></p
                    >
                  {:else}
                    <p class="front kind">{kindsLabel(row)}</p>
                  {/if}
                  <div class="side">
                    <span class="schedule" class:paused={card.state === "known"}>{scheduleLabel(card, now)}</span>
                    <Button
                      variant="quiet"
                      small
                      disabled={remove.isPending}
                      title={row.length === 1 ? "Delete this card and its reviews" : "Delete these cards and their reviews"}
                      onclick={() => void deleteRow(row)}>Delete</Button
                    >
                  </div>
                </li>
              {/each}
            </ul>
          </li>
        {/each}
      </ul>
      {#if list.hasNextPage}
        <Button variant="quiet" disabled={list.isFetchingNextPage} onclick={() => void list.fetchNextPage()}>Show more</Button>
      {/if}
    {/if}
  {/if}
  {#if failure}
    <p class="error" role="alert">{failure}</p>
  {/if}
</Page>

<style>
  .cards {
    list-style: none;
    margin: 0 0 1rem;
    padding: 0;
  }

  .stale {
    opacity: 0.6;
  }

  .cards > li {
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--line);
  }

  .cards p {
    margin: 0;
  }

  .cards p + p {
    margin-top: 0.2rem;
  }

  .rows {
    list-style: none;
    margin: 0.35rem 0 0;
    padding: 0;
  }

  .rows li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.2rem 0;
  }

  .front {
    min-width: 0;
  }

  .sentence,
  .lemma {
    font-family: var(--reading);
  }

  .lemma {
    font-size: 1.1rem;
  }

  .sentence {
    margin-right: 0.35rem;
  }

  mark {
    background: var(--line);
    color: inherit;
    border-radius: 0.2em;
    padding: 0 0.1em;
  }

  .kind {
    color: var(--muted);
    font-size: 0.9rem;
  }

  .side {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .schedule {
    font-size: 0.85rem;
  }

  .paused,
  .muted {
    color: var(--muted);
  }

  .error {
    color: var(--error);
  }
</style>
