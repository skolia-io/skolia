<script lang="ts">
  import type { Lang, ReadingStatus } from "@skolia/shared/api";
  import { createReadingProgressPage, READING_STATUS_LABELS } from "../lib/reading-progress.ts";
  import DocumentList from "./DocumentList.svelte";
  import ReadingStatusMenu from "./ReadingStatusMenu.svelte";
  let { status, lang }: { status: ReadingStatus; lang: Lang | undefined } = $props();
  const texts = createReadingProgressPage(
    () => status,
    () => lang,
  );
</script>

{#if texts.error}
  <p class="error" role="alert">{texts.error.message}</p>
  <button onclick={() => void texts.refetch()}>Try again</button>
{:else}
  <DocumentList
    label={READING_STATUS_LABELS[status]}
    documents={texts.data?.pages.flatMap((page) => page.items.map((item) => item.document))}
    hasMore={texts.hasNextPage}
    loadingMore={texts.isFetchingNextPage}
    onmore={() => void texts.fetchNextPage()}
  >
    {#snippet empty()}
      No texts with this reading progress{lang ? " in this language" : ""}.
    {/snippet}
    {#snippet aside(doc)}
      <ReadingStatusMenu id={doc.id} {status} />
    {/snippet}
  </DocumentList>
{/if}

<style>
  .error {
    color: var(--error);
  }
</style>
