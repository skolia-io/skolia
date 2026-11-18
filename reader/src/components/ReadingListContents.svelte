<script lang="ts">
  import type { Lang, ReadingListId } from "@skolia/shared/api";
  import { createReadingListTexts, createReadingListChange } from "../lib/reading-lists.ts";
  import DocumentList from "./DocumentList.svelte";
  import SaveToLists from "./SaveToLists.svelte";
  let { id, lang }: { id: ReadingListId; lang: Lang | undefined } = $props();
  const texts = createReadingListTexts(
    () => id,
    () => lang,
  );
  const change = createReadingListChange();
</script>

{#if texts.error}
  <p class="error" role="alert">{texts.error.message}</p>
  <button onclick={() => void texts.refetch()}>Try again</button>
{:else}
  <DocumentList
    label="Texts"
    documents={texts.data?.pages.flatMap((page) => page.items.map((item) => item.document))}
    hasMore={texts.hasNextPage}
    loadingMore={texts.isFetchingNextPage}
    onmore={() => void texts.fetchNextPage()}
  >
    {#snippet empty()}
      No texts here yet{lang ? " in this language" : ""}. Find something in <a href="#/">Explore</a> and add it to this list.
    {/snippet}
    {#snippet aside(doc)}
      <SaveToLists id={doc.id} />
      <button class="remove" disabled={change.isPending} onclick={() => change.mutate({ listId: id, id: doc.id, saved: false })}
        >Remove</button
      >
    {/snippet}
  </DocumentList>
{/if}
{#if change.error}
  <p class="error" role="alert">{change.error.message}</p>
{/if}

<style>
  .error {
    color: var(--error);
  }
  .remove {
    font-size: 0.85rem;
    color: var(--muted);
  }
</style>
