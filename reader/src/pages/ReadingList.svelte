<script lang="ts">
  import { tick } from "svelte";
  import { LANGS, LANGUAGE_INFO, type ReadingListId, type User } from "@skolia/shared/api";
  import { ReadingListIdParam } from "@skolia/shared/schemas";
  import { signIn } from "../lib/api.ts";
  import { queryReadingLists, createReadingListEdit, findReadingLists } from "../lib/reading-lists.ts";
  import { hashQuery, readReadingList } from "../lib/filters.ts";
  import Button from "../components/Button.svelte";
  import Page from "../components/Page.svelte";
  import ReadingListContents from "../components/ReadingListContents.svelte";
  import SearchField from "../components/SearchField.svelte";

  let { user }: { user: User | null | undefined } = $props();
  let query = $state(hashQuery(location.hash));
  const selected = $derived(ReadingListIdParam.safeParse(query.get("list")));
  const lang = $derived(readReadingList(query) ?? undefined);
  const lists = queryReadingLists();
  const edit = createReadingListEdit();
  let search = $state("");
  let name = $state("");
  let action = $state<"create" | "rename" | "delete">("create");
  let dialog: HTMLDialogElement;
  let nameInput: HTMLInputElement | undefined = $state();
  const current = $derived(selected.success ? lists.data?.find((list) => list.id === selected.data) : undefined);
  const title = $derived(current?.name ?? (selected.success ? "Reading list" : "Reading lists"));
  const shown = $derived(findReadingLists(lists.data, search));
  function link(list: ReadingListId): string {
    const next = new URLSearchParams({ list: String(list) });
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
  <select
    class:active={lang !== undefined}
    value={lang ?? "all"}
    onchange={(event) => language(event.currentTarget.value)}
    aria-label="Language"
  >
    <option value="all">All languages</option>
    {#each LANGS as code (code)}
      <option value={code} lang={code}>{LANGUAGE_INFO[code].flag} {LANGUAGE_INFO[code].endonym}</option>
    {/each}
  </select>
{/snippet}

<Page title={title} wide>
  {#if user === null}
    <p class="muted">Sign in to save texts and make your own reading lists.</p>
    <Button variant="primary" onclick={() => void signIn()}>Sign in</Button>
  {:else if user}
    {#if selected.success}
      <a class="back" href="#/list"><span aria-hidden="true">←</span> Reading lists</a>
      {#if current}
        <header class="detail-bar">
          <h2>{current.name}</h2>
          <div class="buttons">
            <Button small variant="quiet" onclick={() => void show("rename")}>Rename</Button>
            <Button small variant="danger" onclick={() => void show("delete")}>Delete list</Button>
          </div>
        </header>
        <section aria-label="List contents">
          {#key current.id}
            <ReadingListContents id={current.id} lang={lang} controls={filter} />
          {/key}
        </section>
      {:else}
        {#if lists.isPending}
          <p class="muted" role="status">Loading…</p>
        {:else if !lists.error}
          <p>This reading list no longer exists.</p>
        {/if}
      {/if}
    {:else}
      <SearchField bind:value={search} label="Find a reading list" />
      <div class="list-table">
        <div class="list-table-head">
          <span>{shown.length.toLocaleString()} {shown.length === 1 ? "list" : "lists"}</span>
          <Button small variant="quiet" onclick={() => void show("create")} disabled={!lists.data || lists.data.length >= 200}
            >New list</Button
          >
        </div>
        {#if lists.isPending}
          <p class="empty muted" role="status">Loading lists…</p>
        {:else if shown.length}
          <table aria-label="Reading lists">
            <thead><tr><th scope="col">List</th><th scope="col" class="count">Texts</th></tr></thead>
            <tbody>
              {#each shown as list (list.id)}
                <tr>
                  <th scope="row"><a href={link(list.id)}>{list.name}</a></th>
                  <td class="count">{list.documentsCount.toLocaleString()}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else if lists.data}
          <p class="empty muted">{search.trim() ? `No lists match “${search}”.` : "No reading lists yet."}</p>
        {/if}
      </div>
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
        <p>“{current?.name}” will be removed. Its texts won't be deleted.</p>
      {:else}
        <label for="list-name">{action === "create" ? "New list name" : "List name"}</label>
        <input id="list-name" placeholder="e.g. Weekend reading" maxlength="100" required bind:this={nameInput} bind:value={name} />
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
  h2 {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 650;
  }
  .muted {
    color: var(--muted);
  }
  .list-table-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem 0.4rem 1rem;
    border-bottom: 1px solid var(--line);
    background: var(--bg);
    font-size: 0.9rem;
    font-weight: 600;
  }
  .empty {
    margin: 0;
    padding: 1.25rem 1rem;
  }
  .list-table {
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
    background: var(--surface);
    box-shadow: var(--card-shadow);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    text-align: left;
  }
  thead {
    color: var(--muted);
    font-size: 0.8rem;
  }
  thead th,
  .count {
    padding: 0.65rem 1rem;
  }
  tbody tr {
    border-top: 1px solid var(--line);
  }
  tbody tr:hover,
  tbody tr:focus-within {
    background: var(--bg);
  }
  tbody th {
    padding: 0;
    font-family: var(--reading);
    font-weight: 600;
  }
  tbody a {
    display: block;
    padding: 0.7rem 1rem;
    overflow-wrap: anywhere;
    color: var(--text);
    text-decoration: none;
  }
  tbody a:hover {
    color: var(--accent);
    text-decoration: underline;
  }
  tbody a:focus-visible {
    outline-offset: -3px;
  }
  .count {
    width: 1%;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
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
  .detail-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.65rem;
    margin-bottom: 0.85rem;
  }
  .detail-bar h2 {
    font-family: var(--reading);
    font-size: clamp(1.4rem, 3.5vw, 1.75rem);
    line-height: 1.2;
    overflow-wrap: anywhere;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
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
</style>
