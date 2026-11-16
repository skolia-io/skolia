<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { LANGS, LANGUAGE_INFO, blankParts, type Card, type Lang, type User } from "@skolia/shared/api";
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
  let error = $state<string | null>(null);
  const failure = $derived(error ?? (cardCounts.error ?? list.error)?.message ?? null);
  const now = new Date();

  function lemmaOf(card: Card, page: CardPage): string {
    return page.entries.get(card.lemmaId)?.lemma ?? card.lemmaId.split(":")[1] ?? card.lemmaId;
  }

  function glossOf(card: Card, page: CardPage): string | null {
    return page.entries.get(card.lemmaId)?.senses[0]?.gloss ?? null;
  }

  async function deleteOne(card: Card): Promise<void> {
    if (!confirm("Delete this card and its reviews?")) return;
    error = null;
    try {
      await remove.mutateAsync(card.id);
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
    <p class="back"><a href="#/review/{selected}">Back to review</a></p>

    {#if !list.data}
      {#if !failure}
        <p class="muted">Loading…</p>
      {/if}
    {:else if cards.length === 0}
      <p class="muted"> No cards in {LANGUAGE_INFO[selected].name} yet. Words you look up in the reader turn into cards here. </p>
    {:else}
      <ul class="cards" class:stale={list.isPlaceholderData}>
        {#each cards as { card, page } (card.id)}
          <li>
            <div class="front">
              {#if card.cloze}
                {@const parts = blankParts(card.cloze)}
                <p class="sentence" lang={selected}>{parts.before}<mark>{parts.blank}</mark>{parts.after}</p>
                <p class="muted">
                  <span lang={selected}>{lemmaOf(card, page)}</span>
                  · <a href="#/doc/{card.cloze.documentId}">Open the text</a>
                </p>
              {:else}
                <p
                  ><strong class="lemma" lang={selected}>{lemmaOf(card, page)}</strong>
                  <span class="kind">{CARD_KIND_LABELS[card.kind]}</span></p
                >
                {#if glossOf(card, page)}
                  <p class="muted">{glossOf(card, page)}</p>
                {/if}
              {/if}
            </div>
            <div class="side">
              <span class="schedule" class:paused={!card.active}>{scheduleLabel(card, now)}</span>
              <Button
                variant="quiet"
                small
                disabled={remove.isPending}
                title="Delete this card and its reviews"
                onclick={() => void deleteOne(card)}
                >Delete</Button
              >
            </div>
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
  .back {
    margin: 0 0 0.5rem;
    font-size: 0.9rem;
  }

  .cards {
    list-style: none;
    margin: 0 0 1rem;
    padding: 0;
  }

  .stale {
    opacity: 0.6;
  }

  .cards li {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--line);
  }

  .front {
    min-width: 0;
  }

  .front p {
    margin: 0;
  }

  .front p + p {
    margin-top: 0.2rem;
  }

  .sentence,
  .lemma {
    font-family: var(--reading);
  }

  .lemma {
    font-size: 1.1rem;
  }

  .kind {
    margin-left: 0.35rem;
    color: var(--muted);
    font-size: 0.8rem;
  }

  .side {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.25rem;
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
