<script lang="ts">
  import type { DocumentId } from "@skolia/shared/api";
  import {
    queryReadingLists,
    createMemberships,
    createReadingListChange,
    createReadingListEdit,
    findReadingLists,
  } from "../lib/reading-lists.ts";

  let { id, title }: { id: DocumentId; title?: string } = $props();
  const menuId = $props.id();
  const anchorName = `--${menuId}`;
  let opened = $state(false);
  let search = $state("");
  let name = $state("");
  const lists = queryReadingLists(() => opened);
  const memberships = createMemberships(
    () => id,
    () => opened,
  );
  const change = createReadingListChange();
  const edit = createReadingListEdit();
  const shown = $derived(findReadingLists(lists.data, search));
</script>

<button
  type="button"
  class="trigger"
  class:icon={title !== undefined}
  style:anchor-name={anchorName}
  popovertarget={menuId}
  aria-label={title ? `Add ${title} to reading lists` : "Add to reading lists"}
>
  {#if title}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <circle cx="19" cy="12" r="1.75" />
    </svg>
  {:else}
    Add to reading list
  {/if}
</button>
<div id={menuId} class="dropdown" style:position-anchor={anchorName} popover ontoggle={(event) => (opened = event.newState === "open")}>
  <h3>Save to reading lists</h3>
  {#if lists.error || memberships.error}
    <p class="error" role="alert">{lists.error?.message ?? memberships.error?.message}</p>
    <button
      type="button"
      onclick={() => {
        void lists.refetch();
        void memberships.refetch();
      }}
      >Try again</button
    >
  {:else if !lists.data || !memberships.data}
    <p role="status">Loading…</p>
  {:else}
    {#if lists.data.length > 6}
      <input type="search" aria-label="Find a reading list" placeholder="Find a list…" bind:value={search}>
    {/if}
    <div class="choices">
      {#each shown as list (list.id)}
        <label>
          <input
            type="checkbox"
            checked={change.isPending && change.variables.listId === list.id ? change.variables.saved : memberships.data.includes(list.id)}
            aria-disabled={change.isPending}
            onchange={(event) => {
              const input = event.currentTarget;
              if (change.isPending) input.checked = !input.checked;
              else change.mutate({ listId: list.id, id, saved: input.checked });
            }}
          >
          <span>{list.name}</span>
        </label>
      {:else}
        <p class="muted">No matching lists.</p>
      {/each}
    </div>
    <form
      onsubmit={(event) => {
        event.preventDefault();
        edit.mutate({ action: "create", name }, { onSuccess: () => (name = "") });
      }}
    >
      <input aria-label="New list name" placeholder="New list name" maxlength="100" required bind:value={name}>
      <button disabled={edit.isPending || !name.trim() || lists.data.length >= 200}>Create</button>
    </form>
    <a href="#/list">Manage reading lists</a>
    {#if change.error || edit.error}
      <p class="error" role="alert">{change.error?.message ?? edit.error?.message}</p>
    {/if}
  {/if}
</div>

<style>
  .trigger {
    font-size: 0.85rem;
    flex: none;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    padding: 0;
    border-color: transparent;
    background: transparent;
    color: var(--muted);
  }
  .icon:hover,
  .icon:has(+ .dropdown:popover-open) {
    background: var(--bg);
    color: var(--text);
  }
  .icon:focus-visible {
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
    top: calc(anchor(bottom) + 0.3rem);
    right: anchor(right);
    position-try-fallbacks:
      flip-block,
      flip-inline,
      flip-block flip-inline,
      --centered;
    box-sizing: border-box;
    margin: 0;
    width: min(20rem, calc(100vw - 2rem));
    max-height: min(32rem, 80dvh);
    overflow: auto;
    padding: 1rem;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: 10px;
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.15);
  }
  @position-try --centered {
    inset: 0;
    margin: auto;
  }
  h3 {
    font-size: 1rem;
    margin: 0 0 0.75rem;
  }
  .choices {
    max-height: 16rem;
    overflow: auto;
    margin-block: 0.5rem;
  }
  label {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    padding: 0.5rem 0;
    cursor: pointer;
    overflow-wrap: anywhere;
  }
  input[type="checkbox"] {
    flex: none;
  }
  form {
    display: flex;
    gap: 0.4rem;
    margin-block: 0.75rem;
  }
  input:not([type="checkbox"]) {
    width: 100%;
    min-width: 0;
  }
  a {
    font-size: 0.85rem;
  }
  .error {
    color: var(--error);
  }
</style>
