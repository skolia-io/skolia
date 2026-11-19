<script lang="ts">
  import type { DocumentId } from "@skolia/shared/api";
  import Button from "./Button.svelte";
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
  let creating = $state(false);
  let menu: HTMLDivElement;
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
    <svg class="bookmark" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v16l-6-4-6 4z" /></svg>
    Save
  {/if}
</button>
<div
  id={menuId}
  class="dropdown"
  style:position-anchor={anchorName}
  popover
  bind:this={menu}
  aria-labelledby={`${menuId}-title`}
  ontoggle={(event) => {
    opened = event.newState === "open";
    if (!opened) {
      search = "";
      creating = false;
    }
  }}
>
  <header>
    <h3 id={`${menuId}-title`}>Save to reading lists</h3>
    <Button variant="icon" small aria-label="Close" onclick={() => menu.hidePopover()}><span aria-hidden="true">×</span></Button>
  </header>
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
    <footer>
      {#if creating}
        <form
          onsubmit={(event) => {
            event.preventDefault();
            edit.mutate(
              { action: "create", name },
              {
                onSuccess: (listId) => {
                  if (listId) change.mutate({ listId, id, saved: true });
                  creating = false;
                  name = "";
                  search = "";
                },
              },
            );
          }}
        >
          <input aria-label="New list name" placeholder="New list name" maxlength="100" required bind:value={name}>
          <Button small variant="primary" type="submit" disabled={edit.isPending || !name.trim()}>Create</Button>
        </form>
      {:else}
        <Button small variant="quiet" disabled={lists.data.length >= 200 || change.isPending} onclick={() => (creating = true)}
          >＋ New list</Button
        >
        <a href="#/list" onclick={() => menu.hidePopover()}>Manage lists</a>
      {/if}
    </footer>
    {#if change.error || edit.error}
      <p class="error" role="alert">{change.error?.message ?? edit.error?.message}</p>
    {/if}
  {/if}
</div>

<style>
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.35rem 0.65rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text);
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
  .trigger:hover {
    border-color: var(--accent);
  }
  .bookmark {
    width: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linejoin: round;
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
    border-radius: 16px;
    box-shadow: 0 12px 36px rgb(0 0 0 / 0.18);
  }
  @position-try --centered {
    inset: 0;
    margin: auto;
  }
  header,
  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  header {
    margin-bottom: 0.55rem;
  }
  header span {
    font-size: 1.25rem;
    line-height: 1;
  }
  footer {
    padding-top: 0.7rem;
    border-top: 1px solid var(--line);
  }
  h3 {
    font-size: 1rem;
    margin: 0;
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
    padding: 0.45rem 0.4rem;
    border-radius: 6px;
    cursor: pointer;
    overflow-wrap: anywhere;
  }
  label:hover,
  label:focus-within {
    background: var(--bg);
  }
  input[type="checkbox"] {
    flex: none;
    accent-color: var(--accent);
  }
  form {
    display: flex;
    gap: 0.4rem;
    width: 100%;
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
