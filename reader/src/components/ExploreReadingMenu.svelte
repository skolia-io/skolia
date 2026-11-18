<script lang="ts">
  import { READING_STATUSES, type DocumentId, type ReadingStatus } from "@skolia/shared/api";
  import { createReadingChange, createReadingEntry, READING_STATUS_LABELS } from "../lib/reading-list.ts";

  let { id, title }: { id: DocumentId; title: string } = $props();
  const menuId = $props.id();
  const anchorName = `--${menuId}`;
  let opened = $state(false);
  let menu: HTMLDivElement;
  const entry = createReadingEntry(
    () => id,
    () => opened,
  );
  const change = createReadingChange();
  const status = $derived(entry.data?.status ?? null);

  function save(next: ReadingStatus | null): void {
    change.mutate({ id, status: next }, { onSuccess: () => menu.hidePopover() });
  }
</script>

<button type="button" class="trigger" style:anchor-name={anchorName} popovertarget={menuId} aria-label="Reading list for {title}">
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="5" cy="12" r="1.75" />
    <circle cx="12" cy="12" r="1.75" />
    <circle cx="19" cy="12" r="1.75" />
  </svg>
</button>

<div
  id={menuId}
  class="dropdown"
  style:position-anchor={anchorName}
  popover
  bind:this={menu}
  ontoggle={(event) => {
    if (event.newState === "open") opened = true;
  }}
>
  <p class="heading">{status === null ? "Add to reading list" : "Reading list"}</p>
  {#if entry.error}
    <p class="error" role="alert">{entry.error.message}</p>
    <button type="button" onclick={() => void entry.refetch()} disabled={entry.isFetching}>Try again</button>
  {:else if entry.data === undefined}
    <p class="message" role="status">Loading…</p>
  {:else}
    {#each READING_STATUSES as option (option)}
      <button type="button" aria-pressed={status === option} disabled={change.isPending} onclick={() => save(option)}>
        {READING_STATUS_LABELS[option]}
        {#if status === option}
          <span aria-hidden="true">✓</span>
        {/if}
      </button>
    {/each}
    {#if status !== null}
      <button type="button" class="remove" disabled={change.isPending} onclick={() => save(null)}>Remove from list</button>
    {/if}
    {#if change.isPending}
      <p class="message" role="status">Saving…</p>
    {:else if change.error}
      <p class="error" role="alert">{change.error.message}</p>
    {/if}
  {/if}
</div>

<style>
  .trigger {
    display: grid;
    place-items: center;
    flex: none;
    width: 2.75rem;
    height: 2.75rem;
    padding: 0;
    border-color: transparent;
    background: transparent;
    color: var(--muted);
  }

  .trigger:hover,
  .trigger:has(+ .dropdown:popover-open) {
    background: var(--bg);
    color: var(--text);
  }

  .trigger:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  svg {
    width: 1.25rem;
    fill: currentColor;
  }

  .dropdown {
    position: fixed;
    inset: auto;
    top: calc(anchor(bottom) + 0.2rem);
    right: anchor(right);
    position-try-fallbacks: flip-block;
    margin: 0;
    width: 12rem;
    padding: 0.25rem;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.15);
  }

  .heading,
  .message,
  .error {
    margin: 0;
    padding: 0.45rem 0.65rem;
    font-size: 0.85rem;
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  .heading {
    font-weight: 600;
  }

  .dropdown button {
    display: flex;
    justify-content: space-between;
    width: 100%;
    padding: 0.45rem 0.65rem;
    border: 0;
    background: transparent;
    text-align: left;
  }

  .dropdown button:hover {
    background: var(--bg);
  }

  .dropdown button[aria-pressed="true"] {
    color: var(--accent);
    font-weight: 600;
  }

  .dropdown .remove,
  .error {
    color: var(--error);
  }
</style>
