<script lang="ts">
  import { tick } from "svelte";
  import {
    CARD_GROUPS,
    LANGUAGE_INFO,
    blankParts,
    RATINGS,
    isLang,
    type CardCounts,
    type CardGroup,
    type Cloze,
    type DueCard,
    type Lang,
    type Rating,
    type User,
  } from "@skolia/shared/api";
  import { LANGUAGES } from "@skolia/shared/lang";
  import type { Sense } from "@skolia/shared/schema";
  import { formTables, lemmaTables, type Table } from "@skolia/shared/paradigm";
  import { featureWords, UPOS_LABEL } from "@skolia/shared/ud";
  import Button from "../components/Button.svelte";
  import Page from "../components/Page.svelte";
  import ParadigmTable from "../components/ParadigmTable.svelte";
  import Pronunciations from "../components/Pronunciations.svelte";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { review, signIn } from "../lib/api.ts";
  import { createRemoveCloze } from "../lib/clozes.ts";
  import { countsQuery, dueQuery, settingsQuery } from "../lib/queries.ts";
  import { clue, keyTarget, shortcut } from "../lib/review.ts";
  import { createMarkKnown } from "../lib/words.ts";

  /** lang and group are the URL's (#/review/pl/forms); without a language, the languages to
   * choose from, and with one, only its cards. group only counts when the settings review forms
   * on their own: without one, words, unless only forms have something. */
  let { user, lang, group: wanted }: { user: User | null | undefined; lang: Lang | null; group: CardGroup | null } = $props();

  const GRADE_LABELS: Record<Rating, string> = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };
  const GROUP_LABELS: Record<CardGroup, string> = { words: "Words", forms: "Forms" };
  const LANGUAGES_PAGE = "#/review";
  const SHOWN_SENSES = 3;

  const client = useQueryClient();
  const cardCounts = createQuery(() => ({ ...countsQuery, enabled: !!user }));
  const settings = createQuery(() => ({ ...settingsQuery, enabled: !!user }));
  const counts = $derived(cardCounts.data ?? null);
  /** Whether forms have their own session; null until the settings have come. */
  const split = $derived(settings.data ? !settings.data.formsWithWords : null);
  /** The card whose answer is shown. */
  let revealedId = $state<string | null>(null);
  let busy = $state(false);
  /** The last action's failure. */
  let error = $state<string | null>(null);
  let showButton = $state<HTMLButtonElement | null>(null);
  let goodButton = $state<HTMLButtonElement | null>(null);
  const markWordKnown = createMarkKnown();
  const deleteCloze = createRemoveCloze();

  /** New or due cards in one group, or with none in both. */
  function sum(c: CardCounts, group: CardGroup | null, which: "new" | "due"): number {
    const groups: readonly CardGroup[] = group ? [group] : CARD_GROUPS;
    return groups.reduce((n, g) => n + c[g][which], 0);
  }

  /** Cards to review in one group, or with none in both. */
  function toReview(c: CardCounts, group: CardGroup | null = null): number {
    return sum(c, group, "new") + sum(c, group, "due");
  }

  const selected = $derived(lang);
  const selectedCounts = $derived(counts?.find((c) => c.lang === selected) ?? null);
  const group = $derived<CardGroup | null>(
    split
      ? (wanted ?? (selectedCounts && toReview(selectedCounts, "words") === 0 && toReview(selectedCounts, "forms") > 0 ? "forms" : "words"))
      : null,
  );
  const session = $derived(dueQuery(selected, group));
  const dueCards = createQuery(() => ({ ...session, enabled: !!user && split !== null }));
  /** The session's cards not yet reviewed; null while they load. */
  const due = $derived(dueCards.data ?? null);
  const card = $derived(due?.cards[0]);
  const revealed = $derived(card !== undefined && card.id === revealedId);
  const failure = $derived(error ?? (cardCounts.error ?? settings.error ?? dueCards.error)?.message ?? null);

  function message(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  /** Takes cards out of this session. */
  function drop(keep: (c: DueCard) => boolean): void {
    client.setQueryData(session.queryKey, (d) => d && { ...d, cards: d.cards.filter(keep) });
  }

  async function reveal(): Promise<void> {
    revealedId = card?.id ?? null;
    await tick();
    goodButton?.focus();
  }

  async function grade(rating: Rating): Promise<void> {
    if (!card || busy) return;
    const { id } = card;
    busy = true;
    error = null;
    try {
      await review(id, rating);
      drop((c) => c.id !== id);
    } catch (e: unknown) {
      error = message(e);
    } finally {
      busy = false;
    }
    await tick();
    showButton?.focus();
  }

  /** Known marks all the word's cards known, which takes them out of reviews, and skips them in this session. */
  async function markKnown(): Promise<void> {
    if (!card || busy) return;
    const { lemmaId } = card;
    busy = true;
    error = null;
    try {
      await markWordKnown.mutateAsync(lemmaId);
      drop((c) => c.lemmaId !== lemmaId);
    } catch (e: unknown) {
      error = message(e);
    } finally {
      busy = false;
    }
    await tick();
    showButton?.focus();
  }

  /** Deletes a cloze card, made from a sentence the parser got wrong or one not worth
   * practising, with its reviews. */
  async function removeCloze(): Promise<void> {
    if (card?.kind !== "cloze" || busy || !confirm("Delete this card and its reviews?")) return;
    const { id, data: cloze } = card;
    busy = true;
    error = null;
    try {
      await deleteCloze.mutateAsync({ documentId: cloze.documentId, start: cloze.blankStart, cardId: id });
      drop((c) => c.id !== id);
    } catch (e: unknown) {
      error = message(e);
    } finally {
      busy = false;
    }
    await tick();
    showButton?.focus();
  }

  function langOf(c: DueCard): Lang | undefined {
    const lang = c.lemmaId.split(":")[0];
    return isLang(lang) ? lang : undefined;
  }

  function sensesFor(c: DueCard): Sense[] {
    return c.entry?.senses ?? [];
  }

  /** The grammar tells apart words a clue can't, like pisać and napisać ("to write"). */
  function hintOf(c: DueCard): string {
    return [UPOS_LABEL[c.entry?.upos ?? "X"], ...featureWords(c.entry?.grammar ?? {})].join(" · ");
  }

  function tablesOf(c: DueCard): Table[] {
    const lang = langOf(c);
    if (!lang || !c.entry || !due) return [];
    const sets = due.featureSets;
    const language = LANGUAGES[lang];
    const featsOf = (id: number) => sets[String(id)];
    return c.kind === "cloze"
      ? formTables(featsOf, c.entry, { text: blankOf(c.data), feats: c.data.feats }, language.paradigm, language.mergeLabels)
      : lemmaTables(featsOf, c.entry, language.paradigm, language.mergeLabels);
  }

  function blankOf(cloze: Cloze): string {
    return blankParts(cloze).blank;
  }

  function lemmaOf(c: DueCard): string {
    return c.entry?.lemma ?? c.lemmaId.split(":")[1] ?? c.lemmaId;
  }

  function onkeydown(event: KeyboardEvent): void {
    if (!selected) return;
    // KeyboardEvent's fields are getters on its prototype, which a spread wouldn't copy
    const { key, repeat, altKey, ctrlKey, metaKey } = event;
    const action = shortcut({ key, repeat, altKey, ctrlKey, metaKey, target: keyTarget(event.target) }, revealed);
    if (action === null || (action.kind !== "leave" && (!card || busy))) return;
    event.preventDefault();
    switch (action.kind) {
      case "leave":
        location.hash = LANGUAGES_PAGE;
        break;
      case "reveal":
        void reveal();
        break;
      case "grade":
        void grade(action.rating);
        break;
    }
  }
</script>

<svelte:window onkeydown={onkeydown} />

{#snippet lemma(c: DueCard)}
  <p class="prompt" lang={langOf(c)}>{lemmaOf(c)}</p>
{/snippet}

{#snippet prompt(c: DueCard)}
  {@const first = sensesFor(c)[0]}
  {#if first}
    <p class="prompt">{clue(first.gloss)}</p>
    <p class="muted">{hintOf(c)}</p>
  {:else}
    <p class="muted">No dictionary meaning yet, so this card has no clue.</p>
  {/if}
{/snippet}

<!-- The sentence with the word left blank and its lemma to go on, or filled in -->
{#snippet sentence(c: DueCard, cloze: Cloze, filled: boolean)}
  {@const parts = blankParts(cloze)}
  <p class="sentence" lang={langOf(c)}>
    {parts.before}{#if filled}
      <mark>{parts.blank}</mark>
    {:else}
      <span class="blank"><span class="visually-hidden">blank</span></span> <span class="base">({lemmaOf(c)})</span>
    {/if}{parts.after}
  </p>
{/snippet}

{#snippet why(cloze: Cloze)}
  {@const grammar = featureWords(cloze.feats)}
  {#if grammar.length > 0}
    <p class="muted">{grammar.join(" · ")}</p>
  {/if}
  {#if cloze.why}
    <p class="why">{cloze.why}</p>
  {/if}
  <p class="source"><a href="#/doc/{cloze.documentId}">Open the text</a></p>
{/snippet}

{#snippet answer(c: DueCard)}
  {@const lang = langOf(c)}
  {@const said = c.entry?.pronunciations ?? []}
  {#if said.length > 0}
    <Pronunciations said={said} />
  {/if}
  {@render meanings(c)}
  {@const tables = tablesOf(c)}
  {#if lang && tables.length > 0}
    <details class="forms">
      <summary>Forms</summary>
      {#each tables as table (table.title)}
        <ParadigmTable lang={lang} table={table} />
      {/each}
    </details>
  {/if}
{/snippet}

{#snippet meanings(c: DueCard)}
  {@const senses = sensesFor(c).slice(0, SHOWN_SENSES)}
  {#if c.kind === "cloze"}
    <p class="muted">{UPOS_LABEL[c.entry?.upos ?? "X"]}</p>
  {/if}
  {#if senses.length > 0}
    <ul class="glosses">
      {#each senses as sense, i (i)}
        <li
          >{sense.gloss}{#if sense.tags.length > 0}
            <span class="tags">{sense.tags.join(", ")}</span>
          {/if}</li
        >
      {/each}
    </ul>
  {:else}
    <p class="muted">No dictionary meaning yet.</p>
  {/if}
{/snippet}

{#snippet tally(c: CardCounts, group: CardGroup | null)}
  {@const fresh = sum(c, group, "new")}
  {@const due = sum(c, group, "due")}
  {#if fresh + due === 0}
    <span class="muted">Done for today</span>
  {:else}
    <span class="tally"
      >{#if fresh > 0}
        <span class="new">{fresh} new</span>
      {/if}{#if fresh > 0 && due > 0}
        {" "}·{" "}
      {/if}{#if due > 0}
        <span class="due">{due} due</span>
      {/if}</span
    >
  {/if}
{/snippet}

{#if !selected}
  <Page title="Review">
    {#if user === null}
      <p class="muted">Sign in to review your words.</p>
      <Button variant="primary" onclick={() => void signIn()}>Sign in</Button>
    {:else if counts && counts.length === 0}
      <p class="muted">Nothing to review yet. Words you look up in the reader turn into cards here.</p>
    {:else if counts && split !== null}
      <ul class="languages">
        {#each counts as c (c.lang)}
          {@const info = LANGUAGE_INFO[c.lang]}
          <li class={{ done: toReview(c) === 0 }}>
            {#if split}
              <p class="language" lang={c.lang}><span class="flag" aria-hidden="true">{info.flag}</span> {info.endonym}</p>
              {#each CARD_GROUPS as g (g)}
                <a class="group" href="#/review/{c.lang}/{g}"><span>{GROUP_LABELS[g]}</span> {@render tally(c, g)}</a>
              {/each}
            {:else}
              <a class="whole" href="#/review/{c.lang}">
                <span class="language" lang={c.lang}><span class="flag" aria-hidden="true">{info.flag}</span> {info.endonym}</span>
                {@render tally(c, null)}
              </a>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if failure}
      <p class="error" role="alert">{failure}</p>
    {/if}
  </Page>
{:else}
  <main class="session">
    <h1 class="visually-hidden">
      Review {LANGUAGE_INFO[selected].name}{#if group}
        , {GROUP_LABELS[group].toLowerCase()}
      {/if}
    </h1>
    <div class="bar">
      <a class="leave" href={LANGUAGES_PAGE} aria-label="Stop reviewing" aria-keyshortcuts="Escape">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </a>
      {#if card?.kind === "cloze"}
        <Button variant="quiet" small disabled={busy} title="Delete this card and its reviews" onclick={removeCloze}>Delete</Button>
      {:else if card}
        <Button variant="quiet" small disabled={busy} title="You know this word: stop reviewing it" onclick={markKnown}>Known</Button>
      {/if}
    </div>

    <div class="stage">
      {#if user === null}
        <p class="muted">Sign in to review your words.</p>
        <Button variant="primary" onclick={() => void signIn()}>Sign in</Button>
      {:else if card}
        <section class="flashcard" aria-live="polite" aria-atomic="true">
          {#if card.kind === "cloze"}
            {@render sentence(card, card.data, revealed)}
          {:else if card.kind === "recognition"}
            {@render lemma(card)}
            <p class="muted">{hintOf(card)}</p>
          {:else}
            {@render prompt(card)}
          {/if}
          {#if revealed}
            <hr />
            {#if card.kind === "cloze"}
              {@render why(card.data)}
            {:else if card.kind === "production"}
              {@render lemma(card)}
            {/if}
            {@render answer(card)}
          {/if}
        </section>
      {:else if due}
        <p class="muted">Nothing more to review for now.</p>
        <a href={LANGUAGES_PAGE}>Back</a>
      {/if}
      {#if failure}
        <p class="error" role="alert">{failure}</p>
      {/if}
    </div>

    {#if card}
      <div class="controls">
        {#if revealed}
          <div class="grades">
            {#each RATINGS as rating (rating)}
              {#if rating === 3}
                <Button
                  variant="primary"
                  disabled={busy}
                  aria-keyshortcuts={String(rating)}
                  bind:element={goodButton}
                  onclick={() => grade(rating)}>{GRADE_LABELS[rating]}</Button
                >
              {:else}
                <Button variant="quiet" disabled={busy} aria-keyshortcuts={String(rating)} onclick={() => grade(rating)}
                  >{GRADE_LABELS[rating]}</Button
                >
              {/if}
            {/each}
          </div>
        {:else}
          <Button variant="primary" disabled={busy} aria-keyshortcuts="Space Enter" bind:element={showButton} onclick={reveal}
            >Show answer</Button
          >
        {/if}
      </div>
    {/if}
  </main>
{/if}

<style>
  .muted {
    color: var(--muted);
  }

  .error {
    color: var(--error);
  }

  /* The languages, like a deck list: each a tile to start its review from */
  .languages {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
    gap: 0.75rem;
    margin: 1.5rem 0 0;
    padding: 0;
    list-style: none;
  }

  .languages li {
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 10px;
    box-shadow: var(--card-shadow);
    overflow: hidden;
  }

  .language {
    margin: 0;
    font-family: var(--reading);
    font-size: 1.25rem;
  }

  .languages a {
    color: var(--text);
    text-decoration: none;
  }

  .languages a:hover,
  .languages a:focus-visible {
    background: var(--current);
    outline: none;
  }

  .whole {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 1rem 1.1rem;
  }

  li > .language {
    padding: 1rem 1.1rem 0.5rem;
  }

  .group {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 1.1rem;
    border-top: 1px solid var(--line);
  }

  .tally {
    font-size: 0.9rem;
    color: var(--muted);
  }

  .new {
    color: var(--accent);
  }

  .due {
    color: var(--trigger);
  }

  .done .language {
    color: var(--muted);
  }

  /* A language's review: only the card, centred, with its controls at the bottom */
  .session {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 100dvh;
    max-width: 40rem;
    margin: 0 auto;
    padding: 0 var(--gutter);
  }

  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: var(--nav-height);
    color: var(--muted);
  }

  .leave {
    display: grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    margin-left: -0.5rem;
    border-radius: 6px;
    color: var(--muted);
  }

  .leave:hover,
  .leave:focus-visible {
    background: var(--current);
    color: var(--text);
    outline: none;
  }

  .leave svg {
    width: 1.1rem;
    height: 1.1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
  }

  .stage {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 1rem 0 2rem;
    text-align: center;
  }

  .stage > p {
    margin: 0;
  }

  .flashcard {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
  }

  .controls {
    position: sticky;
    bottom: 0;
    display: flex;
    justify-content: center;
    padding: 0.75rem 0 calc(1rem + env(safe-area-inset-bottom));
    background: var(--bg);
  }

  .controls > :global(button) {
    min-width: min(16rem, 100%);
  }

  .prompt {
    font-family: var(--reading);
    font-size: 2rem;
    margin: 0;
  }

  .sentence {
    font-family: var(--reading);
    font-size: 1.5rem;
    line-height: 1.6;
    margin: 0;
  }

  .blank {
    display: inline-block;
    width: 3em;
    border-bottom: 2px solid var(--muted);
  }

  .base {
    color: var(--muted);
  }

  mark {
    background: none;
    color: inherit;
    font-weight: 600;
    border-bottom: 2px solid var(--accent);
  }

  .why,
  .source {
    margin: 0;
  }

  .source {
    font-size: 0.85rem;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .glosses {
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 1.1rem;
  }

  .tags {
    font-size: 0.75rem;
    color: var(--muted);
    margin-left: 0.3rem;
  }

  hr {
    width: 100%;
    border: 0;
    border-top: 1px solid var(--line);
  }

  .forms {
    margin-top: 0.75rem;
    text-align: left;
  }

  .forms summary {
    cursor: pointer;
    color: var(--muted);
  }

  .grades {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.5rem;
    width: 100%;
  }

  .grades :global(button) {
    padding-inline: 0;
  }
</style>
