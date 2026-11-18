<script lang="ts">
  import { READING_STATUSES, type DocumentId, type ReadingStatus } from "@skolia/shared/api";
  import { READING_STATUS_LABELS, createReadingChange } from "../lib/reading-progress.ts";
  import SaveToLists from "./SaveToLists.svelte";

  /** A text's status on the reading list, null when it isn't on it, and a menu to change it. */
  let { id, status }: { id: DocumentId; status: ReadingStatus | null } = $props();

  const change = createReadingChange();
  /** What's asked for shows while it's saved. */
  const shown = $derived(change.isPending ? change.variables.status : status);

  function onchange(event: Event & { currentTarget: HTMLSelectElement }): void {
    const value = event.currentTarget.value;
    change.mutate({ id, status: READING_STATUSES.find((s) => s === value) ?? null });
  }
</script>

<span class="reading-status">
  <SaveToLists {id} />
  <select class={{ on: shown !== null }} value={shown ?? ""} aria-label="Reading progress" disabled={change.isPending} {onchange}>
    <option value="">{shown === null ? "Reading progress" : "Clear progress"}</option>
    {#each READING_STATUSES as s (s)}
      <option value={s}>{s === "to-read" ? "Not started" : READING_STATUS_LABELS[s]}</option>
    {/each}
  </select>
  {#if change.error}
    <span class="error" role="alert">{change.error.message}</span>
  {/if}
</span>

<style>
  .reading-status {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  select {
    padding: 0.25rem 1.6rem 0.25rem 0.6rem;
    background-position: right 0.45rem center;
    background-size: 0.75rem;
    color: var(--muted);
    font-size: 0.85rem;
    field-sizing: content;
  }

  select.on {
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    color: var(--accent);
    font-weight: 600;
  }

  .error {
    color: var(--error);
    font-size: 0.8rem;
  }
</style>
