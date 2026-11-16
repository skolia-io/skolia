<script lang="ts">
  import { LANGS, LANGUAGE_INFO, type Lang, type ReadingStatus, type User } from "@skolia/shared/api";
  import { signIn } from "../lib/api.ts";
  import { READING_STATUS_LABELS, createReadingList } from "../lib/reading-list.ts";
  import { hashQuery, readReadingList, replaceQuery, writeReadingList } from "../lib/filters.ts";
  import Button from "../components/Button.svelte";
  import DocumentList from "../components/DocumentList.svelte";
  import Page from "../components/Page.svelte";
  import ReadingStatusMenu from "../components/ReadingStatusMenu.svelte";

  let { user }: { user: User | null | undefined } = $props();

  let lang = $state<Lang | "all">(readReadingList(hashQuery(location.hash)) ?? "all");

  $effect(() => replaceQuery("#/list", writeReadingList(lang === "all" ? null : lang)));

  /** Takes up a link to the list with another language, such as the nav's, which has none. */
  function follow(): void {
    if (location.hash.split("?")[0] === "#/list") lang = readReadingList(hashQuery(location.hash)) ?? "all";
  }
  const inLang = () => (lang === "all" ? undefined : lang);

  /** The page's sections, in the order they're shown: what's being read first. */
  const ORDER: readonly ReadingStatus[] = ["reading", "to-read", "finished"];
  const lists = ORDER.map((status) => ({ status, list: createReadingList(status, inLang) }));
</script>

<svelte:window onhashchange={follow} />

<Page title="Reading list" wide>
  {#snippet actions()}
    {#if user}
      <select class="lang" bind:value={lang} aria-label="Language">
        <option value="all">All languages</option>
        {#each LANGS as code (code)}
          <option value={code} lang={code}>{LANGUAGE_INFO[code].flag} {LANGUAGE_INFO[code].endonym}</option>
        {/each}
      </select>
    {/if}
  {/snippet}

  {#if user === null}
    <p class="muted">Sign in to keep a list of the texts you're reading.</p>
    <Button variant="primary" onclick={() => void signIn()}>Sign in</Button>
  {:else if user}
    <div class="sections">
      {#each lists as { status, list } (status)}
        {#if list.error}
          <p class="error">{list.error.message}</p>
        {:else}
          <DocumentList
            label={READING_STATUS_LABELS[status]}
            documents={list.data?.pages.flatMap((page) => page.items.map((item) => item.document))}
            hasMore={list.hasNextPage}
            loadingMore={list.isFetchingNextPage || list.isPlaceholderData}
            onmore={() => void list.fetchNextPage()}
          >
            {#snippet empty()}
              {#if status === "to-read"}
                Nothing to read yet. Add a text from its page, or find one in <a href="#/">Explore</a>.
              {:else if status === "reading"}
                You're not reading anything now.
              {:else}
                Nothing finished yet.
              {/if}
            {/snippet}
            {#snippet aside(doc)}
              <ReadingStatusMenu id={doc.id} {status} />
            {/snippet}
          </DocumentList>
        {/if}
      {/each}
    </div>
  {/if}
</Page>

<style>
  .sections {
    display: grid;
    gap: 1.25rem;
  }

  .error {
    color: var(--error);
  }

  .lang {
    padding: 0.3rem 1.6rem 0.3rem 0.6rem;
    background-position: right 0.45rem center;
    background-size: 0.75rem;
    font-size: 0.9rem;
    field-sizing: content;
  }
</style>
