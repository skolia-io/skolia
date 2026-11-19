<script lang="ts">
  import { tick } from "svelte";
  import { LANGS, LANGUAGE_INFO, type User } from "@skolia/shared/api";
  import { ReadingListId } from "@skolia/shared/schemas";
  import { signIn } from "../lib/api.ts";
  import { queryReadingLists, createReadingListEdit, findReadingLists } from "../lib/reading-lists.ts";
  import { hashQuery, readReadingList } from "../lib/filters.ts";
  import Button from "../components/Button.svelte";
  import Page from "../components/Page.svelte";
  import ReadingListCover from "../components/ReadingListCover.svelte";
  import ReadingListContents from "../components/ReadingListContents.svelte";
  import ProgressContents from "../components/ProgressContents.svelte";

  let { user }: { user: User | null | undefined } = $props();
  let query = $state(hashQuery(location.hash));
  const selected = $derived(ReadingListId.safeParse(query.get("list")));
  const progress = $derived(query.get("progress") === "reading" ? "reading" : query.get("progress") === "finished" ? "finished" : null);
  const lang = $derived(readReadingList(query) ?? undefined);
  const lists = queryReadingLists();
  const edit = createReadingListEdit();
  let search = $state("");
  let name = $state("");
  let action = $state<"create" | "rename" | "delete">("create");
  let dialog: HTMLDialogElement;
  let nameInput: HTMLInputElement | undefined = $state();
  const current = $derived(selected.success ? lists.data?.find((list) => list.id === selected.data) : undefined);
  const detail = $derived(selected.success || progress !== null);
  const title = $derived(
    progress === "reading"
      ? "Reading now"
      : progress === "finished"
        ? "Finished"
        : (current?.name ?? (detail ? "Reading list" : "Reading lists")),
  );
  const shown = $derived(findReadingLists(lists.data, search));
  function link(key: "list" | "progress", value: string): string {
    const next = new URLSearchParams({ [key]: value });
    if (lang) next.set("lang", lang);
    return `#/list?${next}`;
  }
  function language(value: string): void {
    const next = new URLSearchParams(query);
    if (value === "all") next.delete("lang");
    else next.set("lang", value);
    location.hash = `#/list?${next}`;
  }
  async function show(next: typeof action): Promise<void> {
    action = next;
    name = next === "rename" ? (current?.name ?? "") : "";
    edit.reset();
    await tick();
    dialog.showModal();
    nameInput?.focus();
  }
  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const done = () => dialog.close();
    if (action === "create") edit.mutate({ action, name }, { onSuccess: done });
    else if (current && action === "rename") edit.mutate({ action, id: current.id, name }, { onSuccess: done });
    else if (current)
      edit.mutate(
        { action: "delete", id: current.id },
        {
          onSuccess: () => {
            done();
            location.hash = "#/list";
          },
        },
      );
  }
</script>

<svelte:window
  onhashchange={() => {
    query = hashQuery(location.hash);
    if (dialog?.open) dialog.close();
  }}
/>

{#snippet filter()}
  <select value={lang ?? "all"} onchange={(event) => language(event.currentTarget.value)} aria-label="Language">
    <option value="all">All languages</option>
    {#each LANGS as code (code)}
      <option value={code} lang={code}>{LANGUAGE_INFO[code].flag} {LANGUAGE_INFO[code].endonym}</option>
    {/each}
  </select>
{/snippet}

<Page {title} wide ownHeading>
  {#if user === undefined}
    <h1>{title}</h1>
  {/if}
  {#if user === null}
    <h1>Reading lists</h1>
    <p class="muted">Sign in to save texts and make your own reading lists.</p>
    <Button variant="primary" onclick={() => void signIn()}>Sign in</Button>
  {:else if user}
    {#if detail}
      <a class="back" href="#/list"><span aria-hidden="true">←</span> Reading lists</a>
      {#if progress}
        <div class="section-bar"><h1>{title}</h1>{@render filter()}</div>
        <p class="muted">Your reading progress is separate from your saved lists.</p>
        {#key progress}
          <ProgressContents status={progress} {lang} />
        {/key}
      {:else if current}
        <div class="detail">
          <header class="summary">
            <ReadingListCover name={current.name} saved={current.id === "to-read"} />
            <h1>{current.name}</h1>
            <p class="metadata"
              ><span>Private list</span><span aria-hidden="true">·</span
              ><span>{current.textsCount} {current.textsCount === 1 ? "text" : "texts"}</span></p
            >
            {#if current.id === "to-read"}
              <p class="muted">Save texts here to come back to them later.</p>
            {:else}
              <div class="buttons">
                <Button small variant="quiet" onclick={() => void show("rename")}>Rename</Button>
                <Button small variant="danger" onclick={() => void show("delete")}>Delete list</Button>
              </div>
            {/if}
          </header>
          <section class="contents" aria-label="List contents">
            <div class="section-bar"><h2>Texts</h2>{@render filter()}</div>
            {#key current.id}
              <ReadingListContents id={current.id} {lang} />
            {/key}
          </section>
        </div>
      {:else}
        <h1>{title}</h1>
        {#if lists.isPending}
          <p class="muted" role="status">Loading…</p>
        {:else if !lists.error}
          <p>This reading list no longer exists.</p>
        {/if}
      {/if}
    {:else}
      <header class="library-head">
        <div
          ><h1>Reading lists</h1><p class="muted">Organize saved texts and find your next read.</p></div
        >
        <Button variant="primary" onclick={() => void show("create")} disabled={!lists.data || lists.data.length >= 200}
          ><span aria-hidden="true">＋</span>
          New list</Button
        >
      </header>
      <nav class="progress-links" aria-label="Reading progress">
        <a href={link("progress", "reading")}
          ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6l2 2 2-2h6v15h-6l-2 2-2-2H4zM12 6v15" /></svg>
          Reading now</a
        >
        <a href={link("progress", "finished")}
          ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
          Finished</a
        >
      </nav>
      <div class="section-bar library-bar">
        <h2>Your lists</h2>
        {#if (lists.data?.length ?? 0) > 6}
          <label class="search">
            <svg viewBox="0 0 24 24" aria-hidden="true"
              ><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4 4" /></svg
            >
            <input type="search" aria-label="Find a reading list" placeholder="Find a list" bind:value={search}>
          </label>
        {/if}
      </div>
      {#if lists.isPending}
        <p class="muted" role="status">Loading lists…</p>
      {/if}
      <ul class="lists">
        {#each shown as list (list.id)}
          <li>
            <a class="list" href={link("list", list.id)}>
              <ReadingListCover name={list.name} count={list.textsCount} saved={list.id === "to-read"} />
              <strong>{list.name}</strong>
              <span class="muted">{list.id === "to-read" ? "Quick save" : "Private list"}</span>
              <span class="sr-only">{list.textsCount} {list.textsCount === 1 ? "text" : "texts"}</span>
            </a>
          </li>
        {:else}
          {#if lists.data}
            <li class="muted">No lists match “{search}”.</li>
          {/if}
        {/each}
      </ul>
    {/if}
    {#if lists.error}
      <p class="error" role="alert">{lists.error.message}</p><Button variant="quiet" onclick={() => void lists.refetch()}>Try again</Button>
    {/if}
  {/if}

  <dialog
    bind:this={dialog}
    aria-labelledby="list-dialog-title"
    oncancel={(event) => {
      if (edit.isPending) event.preventDefault();
    }}
  >
    <form onsubmit={submit}>
      <h2 id="list-dialog-title">{action === "create" ? "New reading list" : action === "rename" ? "Rename list" : "Delete list?"}</h2>
      {#if action === "delete"}
        <p>“{current?.name}” will be removed. Its texts and your reading progress won't be deleted.</p>
      {:else}
        <label for="list-name">{action === "create" ? "New list name" : "List name"}</label>
        <input id="list-name" placeholder="e.g. Weekend reading" maxlength="100" required bind:this={nameInput} bind:value={name}>
      {/if}
      {#if edit.error}
        <p class="error" role="alert">{edit.error.message}</p>
      {/if}
      <div class="dialog-actions">
        <Button variant="quiet" disabled={edit.isPending} onclick={() => dialog.close()}>Cancel</Button>
        <Button
          variant={action === "delete" ? "destructive" : "primary"}
          type="submit"
          disabled={edit.isPending || (action !== "delete" && !name.trim())}
        >
          {action === "create" ? "Create list" : action === "rename" ? "Save name" : "Delete list"}
        </Button>
      </div>
    </form>
  </dialog>
</Page>

<style>
  h1 {
    margin: 0;
    font-size: clamp(1.85rem, 4.5vw, 2.5rem);
    overflow-wrap: anywhere;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 650;
  }
  .muted,
  .metadata {
    color: var(--muted);
  }
  .library-head,
  .section-bar {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem 1rem;
  }
  .library-head {
    align-items: flex-start;
  }
  .library-head p {
    margin: 0.4rem 0 0;
  }
  .progress-links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 1.25rem;
  }
  svg {
    width: 1.1rem;
    height: 1.1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .progress-links a {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.4rem 0.7rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface);
    text-decoration: none;
    color: var(--text);
    font-size: 0.875rem;
  }
  .progress-links a:hover {
    border-color: var(--accent);
  }
  .library-bar {
    margin: 1.8rem 0 1rem;
  }
  .search {
    position: relative;
    color: var(--muted);
    width: min(100%, 14rem);
  }
  .search svg {
    position: absolute;
    top: 50%;
    left: 0.65rem;
    transform: translateY(-50%);
    pointer-events: none;
  }
  .search input {
    width: 100%;
    padding: 0.4rem 0.6rem 0.4rem 2rem;
    font-size: 0.875rem;
  }
  .lists {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 11rem), 1fr));
    gap: 1.25rem 1rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .list {
    display: grid;
    gap: 0.2rem;
    color: var(--text);
    text-decoration: none;
    border-radius: 12px;
  }
  .list strong {
    margin-top: 0.35rem;
    font-weight: 650;
    overflow-wrap: anywhere;
  }
  .list > span {
    font-size: 0.84rem;
  }
  .list:hover strong {
    color: var(--accent);
    text-decoration: underline;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    margin-bottom: 1.1rem;
    text-decoration: none;
    font-size: 0.9rem;
  }
  .back:hover {
    text-decoration: underline;
  }
  .detail {
    display: grid;
    grid-template-columns: minmax(0, 16rem) minmax(0, 1fr);
    align-items: start;
    gap: 1.5rem;
  }
  .summary {
    display: grid;
    gap: 0.65rem;
    padding: 0.85rem;
    border: 1px solid var(--line);
    border-radius: 16px;
    background: var(--surface);
  }
  .summary h1 {
    font-size: clamp(1.55rem, 3.5vw, 1.95rem);
  }
  .summary p {
    margin: 0;
    font-size: 0.88rem;
  }
  .metadata,
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .contents > .section-bar {
    margin-bottom: 0.65rem;
  }
  select {
    font-size: 0.85rem;
  }
  dialog {
    width: min(25rem, calc(100% - 2rem));
    padding: 1.35rem;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--surface);
    color: var(--text);
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 0.45);
  }
  form {
    display: grid;
    gap: 0.85rem;
  }
  form label {
    font-size: 0.85rem;
    color: var(--muted);
  }
  form p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.35rem;
  }
  .error {
    color: var(--error);
  }
  @media (max-width: 41rem) {
    .detail {
      grid-template-columns: minmax(0, 1fr);
      gap: 1rem;
    }
    .summary {
      grid-template-columns: minmax(4.5rem, 27%) minmax(0, 1fr);
      align-items: start;
      gap: 0.4rem 0.8rem;
    }
    .summary > :global(.cover) {
      grid-row: span 3;
    }
  }
  @media (max-width: 34rem) {
    .lists {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .search {
      width: min(100%, 11rem);
    }
  }
</style>
