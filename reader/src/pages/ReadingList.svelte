<script lang="ts">
  import { LANGS, LANGUAGE_INFO, type Lang, type User } from "@skolia/shared/api";
  import { ReadingListId } from "@skolia/shared/schemas";
  import { signIn } from "../lib/api.ts";
  import { queryReadingLists, createReadingListEdit, findReadingLists } from "../lib/reading-lists.ts";
  import { hashQuery, readReadingList } from "../lib/filters.ts";
  import Button from "../components/Button.svelte";
  import Page from "../components/Page.svelte";
  import ReadingListContents from "../components/ReadingListContents.svelte";
  import ProgressContents from "../components/ProgressContents.svelte";

  let { user }: { user: User | null | undefined } = $props();
  let query = $state(hashQuery(location.hash));
  const selected = $derived(ReadingListId.safeParse(query.get("list")));
  const progress = $derived(query.get("progress") === "reading" ? "reading" : query.get("progress") === "finished" ? "finished" : null);
  const lang = $derived(readReadingList(query) ?? "all");
  const inLang = $derived(lang === "all" ? undefined : lang);
  const lists = queryReadingLists();
  const edit = createReadingListEdit();
  let search = $state("");
  let name = $state("");
  let renaming = $state(false);
  let deleting = $state(false);
  let rename = $state("");
  const current = $derived(selected.success ? lists.data?.find((list) => list.id === selected.data) : undefined);
  const detail = $derived(selected.success || progress !== null);
  const title = $derived(
    progress === "reading"
      ? "Reading now"
      : progress === "finished"
        ? "Finished"
        : detail
          ? (current?.name ?? "Reading list")
          : "Reading lists",
  );
  const shown = $derived(findReadingLists(lists.data, search));
  function link(key: "list" | "progress", value: string): string {
    const next = new URLSearchParams({ [key]: value });
    if (inLang) next.set("lang", inLang);
    return `#/list?${next}`;
  }
  function language(value: string): void {
    const next = new URLSearchParams(query);
    if (value === "all") next.delete("lang");
    else next.set("lang", value);
    location.hash = `#/list?${next}`;
  }
</script>

<svelte:window
  onhashchange={() => {
    query = hashQuery(location.hash);
    renaming = false;
    deleting = false;
    edit.reset();
  }}
/>

<Page {title} wide>
  {#snippet actions()}
    {#if user && detail}
      <select value={lang} onchange={(event) => language(event.currentTarget.value)} aria-label="Language">
        <option value="all">All languages</option>
        {#each LANGS as code (code)}
          <option value={code} lang={code}>{LANGUAGE_INFO[code].flag} {LANGUAGE_INFO[code].endonym}</option>
        {/each}
      </select>
    {/if}
  {/snippet}
  {#if user === null}
    <p class="muted">Sign in to save texts and make your own reading lists.</p>
    <Button variant="primary" onclick={() => void signIn()}>Sign in</Button>
  {:else if user}
    {#if detail}
      <a class="back" href="#/list">← All reading lists</a>
      {#if progress}
        <p class="muted">Reading progress is independent of your lists. Changing it doesn't move or remove saved texts.</p>
        {#key progress}
          <ProgressContents status={progress} lang={inLang} />
        {/key}
      {:else if current}
        <div class="toolbar">
          <p class="muted">{current.textsCount} {current.textsCount === 1 ? "text" : "texts"} · Private list</p>
          {#if current.id !== "to-read"}
            <button
              onclick={() => {
                rename = current.name;
                renaming = !renaming;
                deleting = false;
              }}
              >Rename</button
            >
            <button
              onclick={() => {
                deleting = !deleting;
                renaming = false;
              }}
              >Delete list</button
            >
          {:else}
            <p class="muted">Your quick-save list</p>
          {/if}
        </div>
        {#if renaming}
          <form
            onsubmit={(event) => {
              event.preventDefault();
              if (current) edit.mutate({ action: "rename", id: current.id, name: rename }, { onSuccess: () => (renaming = false) });
            }}
          >
            <input aria-label="List name" maxlength="100" required bind:value={rename}>
            <button disabled={edit.isPending || !rename.trim()}>Save name</button>
            <button type="button" onclick={() => (renaming = false)}>Cancel</button>
          </form>
        {/if}
        {#if deleting}
          <div class="confirmation">
            <p>Delete “{current.name}”? Its texts and your reading progress won't be deleted.</p>
            <button
              disabled={edit.isPending}
              onclick={() => {
                if (current) edit.mutate({ action: "delete", id: current.id }, { onSuccess: () => (location.hash = "#/list") });
              }}
              >Delete list</button
            >
            <button onclick={() => (deleting = false)}>Cancel</button>
          </div>
        {/if}
        {#key current.id}
          <ReadingListContents id={current.id} lang={inLang} />
        {/key}
      {:else if lists.isPending}
        <p class="muted" role="status">Loading…</p>
      {:else if !lists.error}
        <p>This reading list no longer exists.</p>
      {/if}
    {:else}
      <p class="muted"
        >A place for everything you want to read. Save a text to more than one list, and keep your reading progress separately.</p
      >
      <div class="progress-links" aria-label="Reading progress">
        <a href={link("progress", "reading")}>Reading now <span aria-hidden="true">→</span></a>
        <a href={link("progress", "finished")}>Finished <span aria-hidden="true">→</span></a>
      </div>
      <div class="heading"><h2>Your lists</h2><span class="muted">{lists.data?.length ?? 0} / 200</span></div>
      <form
        onsubmit={(event) => {
          event.preventDefault();
          edit.mutate({ action: "create", name }, { onSuccess: () => (name = "") });
        }}
      >
        <input aria-label="New list name" placeholder="Name a new list…" maxlength="100" required bind:value={name}>
        <Button variant="primary" type="submit" disabled={edit.isPending || !name.trim() || (lists.data?.length ?? 0) >= 200}
          >Create list</Button
        >
      </form>
      {#if (lists.data?.length ?? 0) > 6}
        <input class="search" type="search" aria-label="Find a reading list" placeholder="Find a list…" bind:value={search}>
      {/if}
      {#if lists.isPending}
        <p class="muted" role="status">Loading lists…</p>
      {/if}
      <div class="lists">
        {#each shown as list (list.id)}
          <a class="list" href={link("list", list.id)}>
            <span class="list-icon" aria-hidden="true">{list.id === "to-read" ? "☆" : "☷"}</span>
            <span class="list-info"
              ><strong>{list.name}</strong
              ><span class="muted"
                >{list.textsCount} {list.textsCount === 1 ? "text" : "texts"}{list.id === "to-read" ? " · Quick save" : ""}</span
              ></span
            >
            <span class="muted" aria-hidden="true">→</span>
          </a>
        {:else}
          {#if lists.data}
            <p class="muted">No lists match “{search}”.</p>
          {/if}
        {/each}
      </div>
    {/if}
    {#if lists.error}
      <p class="error" role="alert">{lists.error.message}</p><button onclick={() => void lists.refetch()}>Try again</button>
    {/if}
    {#if edit.error}
      <p class="error" role="alert">{edit.error.message}</p>
    {/if}
  {/if}
</Page>

<style>
  .back {
    display: inline-block;
    margin-bottom: 1rem;
  }
  .toolbar,
  .heading {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    margin-bottom: 1rem;
  }
  .toolbar p {
    margin-right: auto;
  }
  .heading {
    margin-top: 2rem;
  }
  h2 {
    font-size: 1.1rem;
    margin: 0;
  }
  form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
  }
  form input {
    flex: 1;
    min-width: 10rem;
    max-width: 26rem;
  }
  .search {
    width: min(100%, 32rem);
    margin-bottom: 1rem;
  }
  .progress-links {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    margin-top: 1.5rem;
  }
  .progress-links a {
    display: flex;
    gap: 2rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    text-decoration: none;
  }
  .lists {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 1fr));
    gap: 0.75rem;
  }
  .list {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1.25rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 10px;
    text-decoration: none;
    color: var(--text);
  }
  .list:hover {
    border-color: var(--accent);
  }
  .list-icon {
    color: var(--accent);
    font-size: 1.75rem;
  }
  .list-info {
    display: grid;
    gap: 0.3rem;
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .list-info .muted {
    font-size: 0.85rem;
  }
  .confirmation {
    padding: 1rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    margin-bottom: 1rem;
  }
  .error {
    color: var(--error);
  }
  select {
    font-size: 0.9rem;
  }
</style>
